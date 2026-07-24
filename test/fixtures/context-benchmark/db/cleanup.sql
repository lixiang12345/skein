DELETE FROM sessions
WHERE expires_at < CURRENT_TIMESTAMP;

-- Expired session cleanup runs before the next worker sweep.
