import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def settings():
    return Settings(llm_provider="fake", _env_file=None, rate_limit_per_minute=3, max_input_chars=100)


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as c:
        yield c
