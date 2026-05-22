from django.urls import path

from . import views

app_name = "dashboard"

urlpatterns = [
    path("", views.dashboard, name="dashboard"),
    path("api/cell/", views.api_cell, name="api_cell"),
    path("api/priority/", views.api_priority, name="api_priority"),
    path("api/aoi/", views.api_aoi, name="api_aoi"),
    path("api/suvradar/summary/", views.api_suvradar_summary, name="api_suvradar_summary"),
]
