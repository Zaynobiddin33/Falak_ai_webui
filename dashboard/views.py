import json

from django.http import HttpResponseBadRequest, JsonResponse
from django.shortcuts import render
from django.views.decorators.http import require_GET

from .ml_mock import compute_cell, compute_priority_list
from .regions import AOI, DISTRICTS


def dashboard(request):
    return render(request, "dashboard/dashboard.html", {
        "aoi": json.dumps(AOI),
        "districts": json.dumps(DISTRICTS),
    })


@require_GET
def api_cell(request):
    try:
        lat = float(request.GET["lat"])
        lng = float(request.GET["lng"])
    except (KeyError, ValueError, TypeError):
        return HttpResponseBadRequest("lat and lng query params required")

    if not (AOI["bounds"]["south"] - 0.5 < lat < AOI["bounds"]["north"] + 0.5):
        return HttpResponseBadRequest("lat outside AOI")
    if not (AOI["bounds"]["west"] - 0.5 < lng < AOI["bounds"]["east"] + 0.5):
        return HttpResponseBadRequest("lng outside AOI")

    return JsonResponse(compute_cell(lat, lng))


@require_GET
def api_priority(request):
    return JsonResponse({"districts": compute_priority_list()})


@require_GET
def api_aoi(request):
    return JsonResponse({"aoi": AOI, "districts": DISTRICTS})
