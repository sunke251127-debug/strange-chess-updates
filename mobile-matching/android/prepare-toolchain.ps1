$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$taskCache = Join-Path $env:LOCALAPPDATA 'StrangeChessMobileBuild'
New-Item -ItemType Directory -Path $taskCache -Force | Out-Null
function Get-VerifiedArchive($Url, $Name, $Hash, $Algorithm) {
  $taskArchive = Join-Path $taskCache $Name
  if (!(Test-Path -LiteralPath $taskArchive) -or (Get-FileHash -LiteralPath $taskArchive -Algorithm $Algorithm).Hash -ne $Hash) {
    Write-Output "Downloading $Name"
    $taskPartial = $taskArchive + '.part'
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $taskPartial -TimeoutSec 600
    if ((Get-FileHash -LiteralPath $taskPartial -Algorithm $Algorithm).Hash -ne $Hash) { throw "Archive checksum failed: $Name" }
    Move-Item -LiteralPath $taskPartial -Destination $taskArchive -Force
  }
  return $taskArchive
}
$taskJdkDir = Join-Path $taskCache 'jdk21'
if (!(Test-Path -LiteralPath $taskJdkDir)) {
  $taskJdkMeta = Invoke-RestMethod -Uri 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&heap_size=normal&image_type=jdk&jvm_impl=hotspot&os=windows&vendor=eclipse'
  $taskJdkPackage = $taskJdkMeta[0].binary.package
  $taskArchiveResult = @(Get-VerifiedArchive $taskJdkPackage.link 'jdk21.zip' $taskJdkPackage.checksum 'SHA256')
  $taskArchive = $taskArchiveResult[-1]
  $taskArchiveResult | Select-Object -SkipLast 1 | Write-Output
  New-Item -ItemType Directory -Path $taskJdkDir -Force | Out-Null
  & tar -xf $taskArchive -C $taskJdkDir
  if ($LASTEXITCODE -ne 0) { throw 'JDK extraction failed' }
}
$taskPlatformDir = Join-Path $taskCache 'platform35'
$taskToolsDir = Join-Path $taskCache 'build-tools35'
if (!(Test-Path -LiteralPath $taskPlatformDir) -or !(Test-Path -LiteralPath $taskToolsDir)) {
  [xml]$taskRepo = (Invoke-WebRequest -UseBasicParsing -Uri 'https://dl.google.com/android/repository/repository2-1.xml').Content
  foreach ($taskSpec in @(@{ Package='platforms;android-35'; Directory=$taskPlatformDir; Name='platform35.zip'; Match='platform-35_r02.zip' }, @{ Package='build-tools;35.0.0'; Directory=$taskToolsDir; Name='build-tools35.zip'; Match='build-tools_r35_windows.zip' })) {
    if (Test-Path -LiteralPath $taskSpec.Directory) { continue }
    $taskPkg = @($taskRepo.'sdk-repository'.remotePackage | Where-Object { $_.path -eq $taskSpec.Package })
    $taskDownload = @($taskPkg.archives.archive | Where-Object { $_.complete.url -eq $taskSpec.Match })[0].complete
    if (!$taskDownload) { throw "Official SDK package metadata unavailable: $($taskSpec.Package)" }
    $taskArchiveResult = @(Get-VerifiedArchive ('https://dl.google.com/android/repository/' + $taskDownload.url) $taskSpec.Name ([string]$taskDownload.checksum) 'SHA1')
    $taskArchive = $taskArchiveResult[-1]
    $taskArchiveResult | Select-Object -SkipLast 1 | Write-Output
    New-Item -ItemType Directory -Path $taskSpec.Directory -Force | Out-Null
    & tar -xf $taskArchive -C $taskSpec.Directory
    if ($LASTEXITCODE -ne 0) { throw 'Android SDK extraction failed' }
  }
}
$taskJava = (Get-ChildItem -LiteralPath $taskJdkDir -Recurse -Filter javac.exe | Select-Object -First 1).DirectoryName
$taskPlatform = (Get-ChildItem -LiteralPath $taskPlatformDir -Recurse -Filter android.jar | Select-Object -First 1).FullName
$taskBuildTools = (Get-ChildItem -LiteralPath $taskToolsDir -Recurse -Filter aapt2.exe | Select-Object -First 1).DirectoryName
if (!$taskJava -or !$taskPlatform -or !$taskBuildTools) { throw 'Incomplete Android toolchain' }
$taskLocal = Join-Path $PSScriptRoot '.local'
New-Item -ItemType Directory -Path $taskLocal -Force | Out-Null
@{ javaBin=$taskJava; androidJar=$taskPlatform; buildTools=$taskBuildTools } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskLocal 'toolchain.json') -Encoding utf8
Write-Output "Android toolchain ready: $taskCache"
