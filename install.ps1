[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Get-EnvironmentValue {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Name
    )

    return [Environment]::GetEnvironmentVariable($Name)
}

function Invoke-Download {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Uri,

        [Parameter(Mandatory = $true)]
        [string] $OutFile,

        [switch] $GitHubApi
    )

    $headers = @{}
    if ($GitHubApi) {
        $headers["Accept"] = "application/vnd.github+json"
    }

    $githubToken = Get-EnvironmentValue -Name "GITHUB_TOKEN"
    if (-not [string]::IsNullOrWhiteSpace($githubToken)) {
        $headers["Authorization"] = "Bearer $githubToken"
    }

    $requestParameters = @{
        Uri = $Uri
        Headers = $headers
        OutFile = $OutFile
    }
    if ($PSVersionTable.PSVersion.Major -lt 6) {
        $requestParameters["UseBasicParsing"] = $true
    }

    Invoke-WebRequest @requestParameters
}

function Resolve-LatestTag {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Repository,

        [Parameter(Mandatory = $true)]
        [string] $TemporaryDirectory
    )

    $releaseJson = Join-Path $TemporaryDirectory "release.json"

    try {
        Invoke-Download `
            -Uri "https://api.github.com/repos/$Repository/releases/latest" `
            -OutFile $releaseJson `
            -GitHubApi
    }
    catch {
        Invoke-Download `
            -Uri "https://api.github.com/repos/$Repository/releases?per_page=1" `
            -OutFile $releaseJson `
            -GitHubApi
    }

    $release = Get-Content -LiteralPath $releaseJson -Raw | ConvertFrom-Json
    if ($release -is [array]) {
        $release = $release | Select-Object -First 1
    }

    $resolvedTag = $release.tag_name
    if ([string]::IsNullOrWhiteSpace($resolvedTag)) {
        throw "No published release was found for $Repository"
    }

    return [string] $resolvedTag
}

function Get-WindowsArchitecture {
    try {
        $osArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }
    catch {
        $osArchitecture = if ($env:PROCESSOR_ARCHITEW6432) {
            $env:PROCESSOR_ARCHITEW6432
        }
        else {
            $env:PROCESSOR_ARCHITECTURE
        }
    }

    switch ($osArchitecture.ToUpperInvariant()) {
        { $_ -in @("X64", "AMD64", "X86_64") } { return "x64" }
        { $_ -in @("ARM64", "AARCH64") } { return "arm64" }
        default { throw "Unsupported architecture: $osArchitecture" }
    }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "install.ps1 only supports Windows"
}

# GitHub requires TLS 1.2, which older Windows PowerShell versions may not
# enable by default.
if ([enum]::GetNames([Net.SecurityProtocolType]) -contains "Tls12") {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

$repository = Get-EnvironmentValue -Name "FTPC_REPO"
if ([string]::IsNullOrWhiteSpace($repository)) {
    $repository = "edoannunziata/ftpc"
}

$tag = Get-EnvironmentValue -Name "FTPC_TAG"
if ([string]::IsNullOrWhiteSpace($tag)) {
    $tag = Get-EnvironmentValue -Name "FTPC_VERSION"
}

$installDirectory = Get-EnvironmentValue -Name "FTPC_INSTALL_DIR"
if ([string]::IsNullOrWhiteSpace($installDirectory)) {
    $localAppData = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::LocalApplicationData
    )
    $installDirectory = Join-Path $localAppData "Programs\ftpc\bin"
}
$installDirectory = [IO.Path]::GetFullPath($installDirectory)

$architecture = Get-WindowsArchitecture
$temporaryDirectory = Join-Path `
    ([IO.Path]::GetTempPath()) `
    ("ftpc-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null

try {
    if ([string]::IsNullOrWhiteSpace($tag) -or $tag -eq "latest") {
        $tag = Resolve-LatestTag `
            -Repository $repository `
            -TemporaryDirectory $temporaryDirectory
        Write-Host "Resolved latest release: $tag"
    }

    if ($tag -in @("master", "master-latest")) {
        throw "Refusing to install from mutable tag: $tag. Set FTPC_TAG to an immutable release tag instead."
    }

    $asset = "ftpc-windows-$architecture.tar.gz"
    $baseUrl = "https://github.com/$repository/releases/download/$tag"
    $archive = Join-Path $temporaryDirectory $asset
    $checksums = Join-Path $temporaryDirectory "checksums.txt"

    Write-Host "Downloading $repository $tag for windows-$architecture"
    Invoke-Download -Uri "$baseUrl/$asset" -OutFile $archive
    Invoke-Download -Uri "$baseUrl/checksums.txt" -OutFile $checksums

    $assetPattern = [regex]::Escape($asset)
    $checksumLine = Get-Content -LiteralPath $checksums |
        Where-Object { $_ -match "^([A-Fa-f0-9]{64})\s+\*?$assetPattern\s*$" } |
        Select-Object -First 1
    if ($null -eq $checksumLine) {
        throw "Checksum for $asset was not found in checksums.txt"
    }

    $expected = [regex]::Match($checksumLine, "^[A-Fa-f0-9]{64}").Value.ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        throw "Checksum mismatch for $asset"
    }

    $tarCommand = Get-Command "tar.exe" -ErrorAction SilentlyContinue
    if ($null -eq $tarCommand) {
        $tarCommand = Get-Command "tar" -ErrorAction SilentlyContinue
    }
    if ($null -eq $tarCommand) {
        throw "Required command not found: tar"
    }

    & $tarCommand.Source -xzf $archive -C $temporaryDirectory
    if ($LASTEXITCODE -ne 0) {
        throw "Could not extract $asset"
    }

    $binary = Join-Path `
        (Join-Path $temporaryDirectory "ftpc-windows-$architecture") `
        "ftpc.exe"
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
        throw "Downloaded package did not contain ftpc.exe"
    }

    New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
    $target = Join-Path $installDirectory "ftpc.exe"
    Copy-Item -LiteralPath $binary -Destination $target -Force

    Write-Host "ftpc installed to $target"

    $pathEntries = $env:PATH -split ";" |
        ForEach-Object { $_.Trim().TrimEnd("\") }
    if ($pathEntries -notcontains $installDirectory.TrimEnd("\")) {
        Write-Host "Add $installDirectory to PATH to run ftpc from any terminal."
    }
}
finally {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
