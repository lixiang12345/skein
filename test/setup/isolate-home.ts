import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Point every test worker at a private home namespace so `loadConfig` and
// friends never read or write the developer's real `~/.mosaic`. Individual
// tests may still override `SKEIN_HOME`/`MOSAIC_HOME`; when they restore the
// previous value they land back on this hermetic default rather than the live
// machine config.
const isolatedHome = mkdtempSync(join(tmpdir(), 'skein-test-home-'));
process.env.SKEIN_HOME = isolatedHome;
delete process.env.MOSAIC_HOME;
