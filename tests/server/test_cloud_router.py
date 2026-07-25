"""Provider routing checks for the direct cloud streaming path."""

from openjarvis.server.cloud_router import get_provider, is_cloud_model


def test_nvidia_prefixed_gemma_routes_to_nvidia() -> None:
    model = "nvidia/google/gemma-4-31b-it"

    assert get_provider(model) == "nvidia"
    assert is_cloud_model(model) is True


def test_unprefixed_gemma_is_not_misrouted_to_openrouter() -> None:
    assert get_provider("google/gemma-4-31b-it") == "openrouter"
