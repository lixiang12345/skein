def 验证会话(token: str) -> bool:
    return token.startswith('session_')
