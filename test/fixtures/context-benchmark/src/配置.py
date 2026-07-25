def 验证会话(token: str) -> bool:
    return token.startswith('session_')


def 加载超时配置(environment: str) -> int:
    """Load the default request timeout for the selected environment."""
    return 30 if environment == 'production' else 5
