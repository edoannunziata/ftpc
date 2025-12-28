# Publishing to PyPI

This guide explains how to build and publish the ftpc package to PyPI.

## Prerequisites

Install the development dependencies:

```bash
pip install -e ".[dev]"
```

Or install build tools separately:

```bash
pip install build twine
```

## Building the Package

1. Clean any previous builds:
   ```bash
   rm -rf dist/ build/ *.egg-info
   ```

2. Build the source distribution and wheel:
   ```bash
   python -m build
   ```

   This creates two files in the `dist/` directory:
   - `ftpc-X.Y.Z.tar.gz` (source distribution)
   - `ftpc-X.Y.Z-py3-none-any.whl` (wheel)

## Testing the Build

1. Verify the package can be installed locally:
   ```bash
   pip install dist/ftpc-*.whl
   ```

2. Test the CLI:
   ```bash
   ftpc --help
   ```

3. Test importing as a library:
   ```bash
   python -c "from ftpc import Storage; print(Storage)"
   ```

## Publishing to Test PyPI (Recommended First)

Before publishing to the real PyPI, test on Test PyPI:

1. Create an account at https://test.pypi.org

2. Generate an API token at https://test.pypi.org/manage/account/token/

3. Upload to Test PyPI:
   ```bash
   twine upload --repository testpypi dist/*
   ```

4. Install from Test PyPI to verify:
   ```bash
   pip install --index-url https://test.pypi.org/simple/ ftpc
   ```

## Publishing to PyPI

1. Create an account at https://pypi.org

2. Generate an API token at https://pypi.org/manage/account/token/

3. Upload to PyPI:
   ```bash
   twine upload dist/*
   ```

   You'll be prompted for your username (use `__token__`) and password (your API token).

4. Alternatively, configure your credentials in `~/.pypirc`:
   ```ini
   [pypi]
   username = __token__
   password = pypi-YourAPITokenHere

   [testpypi]
   username = __token__
   password = pypi-YourTestAPITokenHere
   ```

## Version Management

Update the version in two places before publishing:
1. `pyproject.toml` - the `version` field
2. `ftpc/__init__.py` - the `__version__` variable

Follow semantic versioning (MAJOR.MINOR.PATCH):
- MAJOR: Breaking changes
- MINOR: New features, backwards compatible
- PATCH: Bug fixes

## Pre-Release Checklist

- [ ] Update version in `pyproject.toml` and `ftpc/__init__.py`
- [ ] Update CHANGELOG or release notes
- [ ] Run tests: `pytest`
- [ ] Run type checks: `mypy ftpc`
- [ ] Clean build artifacts: `rm -rf dist/ build/ *.egg-info`
- [ ] Build package: `python -m build`
- [ ] Test installation locally
- [ ] Upload to Test PyPI (optional but recommended)
- [ ] Verify on Test PyPI
- [ ] Upload to PyPI
- [ ] Create git tag: `git tag v0.1.0 && git push origin v0.1.0`

## Troubleshooting

### Twine Check Warnings

You may see warnings from `twine check` about license fields. This is a known issue where older versions of twine don't recognize the newer PEP 639 license metadata format. The package is correctly built and PyPI will accept it.

### Upload Errors

- **403 Forbidden**: Check your API token and ensure it has upload permissions
- **400 Bad Request**: Usually means the version already exists on PyPI
- **File already exists**: You cannot re-upload the same version; increment the version number

## Continuous Integration

Consider setting up GitHub Actions to automatically publish on release:

```yaml
name: Publish to PyPI

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-python@v4
        with:
          python-version: '3.11'
      - name: Install build tools
        run: pip install build twine
      - name: Build package
        run: python -m build
      - name: Publish to PyPI
        env:
          TWINE_USERNAME: __token__
          TWINE_PASSWORD: ${{ secrets.PYPI_API_TOKEN }}
        run: twine upload dist/*
```

Add your PyPI API token as a GitHub secret named `PYPI_API_TOKEN`.
