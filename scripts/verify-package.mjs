import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {appendFile, mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import process from 'node:process';
import {parseArgs} from 'node:util';

const root = resolve(process.cwd());
const {values: options} = parseArgs({
  options: {'output-dir': {type: 'string'}},
  allowPositionals: false,
  strict: true,
});
const outputDir = resolve(options['output-dir'] ?? 'artifacts/package');
const packageJsonPath = join(root, 'package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const expectedBins = ['skein', 'mosaic', 'mosaic-code'];

if (packageJson.name !== '@skein-code/cli') {
  throw new Error(`Unexpected package name: ${packageJson.name}`);
}
if (!packageJson.version) {
  throw new Error('package.json is missing a version');
}
if (!packageJson.bin || expectedBins.some((name) => packageJson.bin[name] !== 'dist/cli.js')) {
  throw new Error('package.json must expose skein, mosaic, and mosaic-code as dist/cli.js');
}

await mkdir(outputDir, {recursive: true});
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packed = spawnSync(npm, ['pack', '--json', '--pack-destination', outputDir], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
if (packed.error) throw packed.error;
if (packed.status !== 0) throw new Error(`npm pack exited with status ${packed.status}`);

let packMetadata;
try {
  packMetadata = JSON.parse(packed.stdout).at(-1);
} catch (error) {
  throw new Error(`Could not parse npm pack metadata: ${error.message}`);
}
if (!packMetadata?.filename || packMetadata.name !== packageJson.name || packMetadata.version !== packageJson.version) {
  throw new Error('npm pack metadata does not match package.json');
}

const tarball = join(outputDir, packMetadata.filename);
const tarballStat = await stat(tarball);
const sha256 = await hashFile(tarball);
const checksumPath = `${tarball}.sha256`;
await writeFile(checksumPath, `${sha256}  ${packMetadata.filename}\n`, 'utf8');

const files = (packMetadata.files ?? []).map((entry) => entry.path);
const requiredFiles = ['dist/cli.js', 'package.json', 'README.md', 'LICENSE'];
for (const required of requiredFiles) {
  if (!files.includes(required)) throw new Error(`Package is missing ${required}`);
}
const forbidden = files.filter((file) =>
  file === '.mosaic' || file.startsWith('.mosaic/') ||
  file === '.skein' || file.startsWith('.skein/') ||
  file === 'node_modules' || file.startsWith('node_modules/'));
if (forbidden.length > 0) {
  throw new Error(`Package contains local state: ${forbidden.join(', ')}`);
}

const prefix = await mkdtemp(join(tmpdir(), 'skein-package-install-'));
try {
  const installed = spawnSync(npm, [
    'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball,
  ], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  if (installed.error) throw installed.error;
  if (installed.status !== 0) {
    throw new Error(`Isolated npm install failed:\n${installed.stdout}\n${installed.stderr}`);
  }
  const binDir = join(prefix, process.platform === 'win32' ? '' : 'bin');
  const commandResults = {};
  for (const name of expectedBins) {
    const command = join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
    const result = spawnSync(command, ['--help'], {
      cwd: root,
      encoding: 'utf8',
      env: {...process.env, SKEIN_HOME: join(prefix, 'home')},
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || !`${result.stdout}${result.stderr}`.includes('Usage: skein')) {
      throw new Error(`${name} did not pass --help from the isolated install`);
    }
    commandResults[name] = 'passed';
  }

  const report = {
    name: packageJson.name,
    version: packageJson.version,
    filename: packMetadata.filename,
    sha256,
    size: tarballStat.size,
    unpackedSize: packMetadata.unpackedSize,
    files: files.length,
    bins: commandResults,
  };
  console.log('Package verification:');
  console.log(JSON.stringify(report, null, 2));
  console.log(`SHA-256: ${sha256}`);
  console.log(`Checksum file: ${checksumPath}`);
  await writeSummary(report);
} finally {
  await rm(prefix, {recursive: true, force: true});
}

async function hashFile(path) {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}

async function writeSummary(report) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const rows = expectedBins.map((name) => `| ${name} | ${report.bins[name]} |`).join('\n');
  await mkdir(dirname(summaryPath), {recursive: true});
  await appendFile(summaryPath, [
    '### Package verification',
    '',
    `- Package: \`${report.name}@${report.version}\``,
    `- Tarball: \`${report.filename}\``,
    `- SHA-256: \`${report.sha256}\``,
    '',
    '| Executable | Result |',
    '| --- | --- |',
    rows,
    '',
  ].join('\n'), 'utf8');
}
