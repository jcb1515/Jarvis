"""Configuration coverage for the physical status-device bridge."""

from pathlib import Path

from openjarvis.core.config import load_config


def test_load_physical_device_config(tmp_path: Path) -> None:
    config_path = tmp_path / "physical-device.toml"
    config_path.write_text(
        """
[physical_device]
enabled = true
token_env = "TEST_DEVICE_TOKEN"
heartbeat_interval_s = 8.5
""".strip(),
        encoding="utf-8",
    )

    config = load_config(config_path)

    assert config.physical_device.enabled is True
    assert config.physical_device.token_env == "TEST_DEVICE_TOKEN"
    assert config.physical_device.heartbeat_interval_s == 8.5
