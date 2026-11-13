param(
    [string]$OutputPath,
    [string]$SdkPackage,
    [string]$CoreExecutable
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
if (-not $OutputPath) { $OutputPath = Join-Path $project 'SevernayaYagoda.exe' }
$OutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)

$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    throw 'Для сборки нужен 64-разрядный компилятор .NET Framework 4.x.'
}

$version = '1.0.4314.35'
$sha512 = '70E6A256A3F7066407327C46A59CC034CDB6B545E0C9CAE2B322478C818DCC868CB26F225E3ECAC7E71E620F916D8C09B734F4D3DA9F7054E872F54B63E7A433'
$packageName = "microsoft.web.webview2.$version.nupkg"
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('severnaya-yagoda-build-' + [Guid]::NewGuid().ToString('N'))
$entries = @(
    'lib/net462/Microsoft.Web.WebView2.Core.dll',
    'lib/net462/Microsoft.Web.WebView2.WinForms.dll',
    'runtimes/win-x64/native/WebView2Loader.dll',
    'LICENSE.txt',
    'NOTICE.txt'
)

New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    if (-not $CoreExecutable) {
        if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Для сборки нужен Cargo из Rust toolchain.' }
        $rustTarget = Join-Path $project 'core/target'
        $oldFlags = $env:RUSTFLAGS
        try {
            $env:RUSTFLAGS = "$oldFlags -C target-feature=+crt-static".Trim()
            & cargo build --locked --release --manifest-path (Join-Path $project 'core/Cargo.toml') --target x86_64-pc-windows-msvc --target-dir $rustTarget
            if ($LASTEXITCODE -ne 0) { throw 'Сборка ядра Rust завершилась с ошибкой.' }
        } finally {
            $env:RUSTFLAGS = $oldFlags
        }
        $CoreExecutable = Join-Path $rustTarget 'x86_64-pc-windows-msvc/release/severnaya-yagoda-core.exe'
    }
    $CoreExecutable = (Resolve-Path -LiteralPath $CoreExecutable).Path
    & node (Join-Path $project 'build.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Сборка интерфейса завершилась с ошибкой.' }

    if (-not $SdkPackage) {
        $SdkPackage = Join-Path $scratch $packageName
        $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/$packageName"
        Invoke-WebRequest -Uri $url -OutFile $SdkPackage -UseBasicParsing -TimeoutSec 60
    }
    if ((Get-FileHash -LiteralPath $SdkPackage -Algorithm SHA512).Hash -ne $sha512) {
        throw 'Контрольная сумма пакета Microsoft WebView2 не совпала.'
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $SdkPackage).Path)
    try {
        foreach ($entry in $entries) {
            $destination = Join-Path $scratch (Split-Path -Leaf $entry)
            [IO.Compression.ZipFileExtensions]::ExtractToFile($archive.GetEntry($entry), $destination)
        }
    } finally {
        $archive.Dispose()
    }

    $core = Join-Path $scratch 'Microsoft.Web.WebView2.Core.dll'
    $forms = Join-Path $scratch 'Microsoft.Web.WebView2.WinForms.dll'
    $loader = Join-Path $scratch 'WebView2Loader.dll'
    $license = Join-Path $scratch 'LICENSE.txt'
    $notice = Join-Path $scratch 'NOTICE.txt'
    $rustLicenses = Join-Path $project 'core/THIRD-PARTY-LICENSES.txt'
    $html = Join-Path $project 'pilot.html'
    $icon = Join-Path $PSScriptRoot 'Pilot.ico'
    $manifest = Join-Path $PSScriptRoot 'Pilot.manifest'
    $code = Join-Path $PSScriptRoot 'Pilot.cs'
    $rustSession = Join-Path $PSScriptRoot 'RustSession.cs'
    $compiled = Join-Path $scratch 'SevernayaYagoda.exe'
    $arguments = @(
        '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
        '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
        "/out:$compiled", "/reference:$core", "/reference:$forms", "/win32icon:$icon", "/win32manifest:$manifest",
        "/resource:$html,Pilot.html", "/resource:$CoreExecutable,PilotCore.exe", "/resource:$core,Microsoft.Web.WebView2.Core.dll",
        "/resource:$forms,Microsoft.Web.WebView2.WinForms.dll", "/resource:$loader,WebView2Loader.dll",
        "/resource:$license,License.txt", "/resource:$notice,Notice.txt",
        "/resource:$rustLicenses,RustLicenses.txt", $code, $rustSession
    )
    & $compiler @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Сборка Windows-приложения завершилась с ошибкой.' }

    Copy-Item -LiteralPath $compiled -Destination $OutputPath
    Get-Item -LiteralPath $OutputPath
} finally {
    Get-ChildItem -LiteralPath $scratch -File | Remove-Item
    Remove-Item -LiteralPath $scratch
}
