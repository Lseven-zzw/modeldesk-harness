import httpx

from app.settings import Settings


def create_upstream_client(
    settings: Settings, transport: httpx.AsyncBaseTransport | None = None
) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=transport,
        timeout=httpx.Timeout(
            connect=settings.upstream_connect_timeout,
            read=settings.upstream_read_timeout,
            write=settings.upstream_write_timeout,
            pool=settings.upstream_pool_timeout,
        ),
        limits=httpx.Limits(max_connections=settings.upstream_pool_max_connections),
        follow_redirects=False,
    )
