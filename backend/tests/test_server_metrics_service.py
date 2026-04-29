from app.services.server_metrics_service import parse_mem_row, parse_os_pretty_name


def test_parse_os_pretty_name() -> None:
    sample = 'NAME="Ubuntu"\nVERSION="22.04.4 LTS (Jammy Jellyfish)"\nPRETTY_NAME="Ubuntu 22.04.4 LTS"\n'
    assert parse_os_pretty_name(sample) == "Ubuntu 22.04.4 LTS"


def test_parse_mem_row() -> None:
    sample = "               total        used        free      shared  buff/cache   available\nMem:            7822        2111        2442         119        3268        5312\nSwap:           2047          10        2037\n"
    total, used = parse_mem_row(sample)
    assert total == 7822
    assert used == 2111
