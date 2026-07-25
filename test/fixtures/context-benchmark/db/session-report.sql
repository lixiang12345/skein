SELECT session_id, created_at
FROM session_audit
WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '1 day';

-- Daily session audit report for operations.
