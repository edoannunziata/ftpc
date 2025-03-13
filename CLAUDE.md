# FTP Client (ftpc) Development Guide

## Build Commands
- Install: `pip install -e .` (basic) or `pip install -e ".[all]"` (all dependencies)
- Type checking: `mypy ftpc`
- Run: `python -m ftpc [remote] [path]`
- Install specific dependencies:
  - Azure: `pip install azure-storage-file-datalake azure-identity`
  - S3: `pip install boto3`
  - SFTP: `pip install paramiko`

## Code Style Guidelines
- **Imports**: Group standard library imports first, then third-party, then local
- **Type hints**: Use strict typing with `mypy` (as configured in pyproject.toml)
- **Naming**: 
  - Classes: PascalCase
  - Functions/methods: snake_case
  - Variables: snake_case
  - Constants: UPPERCASE
- **Error handling**: Use `Exit` exception for fatal errors, contextlib for resource management
- **Documentation**: Document classes and methods with docstrings (see `client.py` for example)
- **Abstractions**: Follow abstract base classes pattern for new client implementations
- **Python version**: Uses modern Python features (match statements, type annotations)
