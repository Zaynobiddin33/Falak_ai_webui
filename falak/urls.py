from django.urls import include, path

urlpatterns = [
    path("", include("core.urls")),
    path("dashboard/", include("dashboard.urls")),
]
