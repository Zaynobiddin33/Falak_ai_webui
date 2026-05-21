import os
import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "falak.settings")
django.setup()

from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402
from channels.security.websocket import AllowedHostsOriginValidator  # noqa: E402
from django.conf import settings  # noqa: E402
from django.core.asgi import get_asgi_application  # noqa: E402

from falak.routing import websocket_urlpatterns  # noqa: E402

django_asgi_app = get_asgi_application()

ws_router = URLRouter(websocket_urlpatterns)
# In DEBUG, accept any Origin (or none) — tools like wscat / Python test scripts
# don't set Origin headers. In production we always validate.
if not settings.DEBUG:
    ws_router = AllowedHostsOriginValidator(ws_router)

application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        "websocket": ws_router,
    }
)
