# Download, verify and silently run the latest Windows NSIS installer.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not [Environment]::Is64BitOperatingSystem) { throw 'GitGUI requires 64-bit Windows.' }
$release = Invoke-RestMethod 'https://api.github.com/repos/MDHaarith/GitGUI/releases/latest'
if ($release.tag_name -notmatch '^v([0-9]+\.[0-9]+\.[0-9]+)$') { throw 'Invalid release version.' }
$version = $Matches[1]
$asset = "GitGUI_${version}_x64-setup.exe"
$url = "https://github.com/MDHaarith/GitGUI/releases/download/v$version"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $installer = Join-Path $tmp $asset
    $checksums = Join-Path $tmp 'SHA256SUMS.txt'
    Invoke-WebRequest "$url/SHA256SUMS.txt" -OutFile $checksums -UseBasicParsing
    Invoke-WebRequest "$url/$asset" -OutFile $installer -UseBasicParsing
    $pattern = '^([0-9a-fA-F]{64}) [ *]' + [regex]::Escape($asset) + '$'
    $entries = @(Get-Content $checksums | Where-Object { $_ -match $pattern })
    if ($entries.Count -ne 1) { throw "Missing or invalid checksum for $asset." }
    $expected = ($entries[0] -split ' ')[0]
    if ((Get-FileHash $installer -Algorithm SHA256).Hash -ne $expected) {
        throw "Checksum mismatch for $asset; refusing to install."
    }
    $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode)." }
    Write-Output "Installed GitGUI $version."
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force
}
