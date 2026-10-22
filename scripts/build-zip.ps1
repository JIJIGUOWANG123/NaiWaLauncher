$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$unpacked = $env:NAIWA_UNPACKED
if (-not $unpacked) { $unpacked = Join-Path $root 'release\win-unpacked' }
if (-not (Test-Path (Join-Path $unpacked 'NaiWa Launcher.exe'))) { throw '缺少 release/win-unpacked，请先执行 pnpm exec electron-builder --win --dir' }
$stage = Join-Path $root '.scratch\portable-stage'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Join-Path $stage 'naiwa') -Force | Out-Null
Copy-Item (Join-Path $unpacked '*') (Join-Path $stage 'naiwa') -Recurse -Force
  # 剔除误留的运行期数据（有人直接跑过 win-unpacked 里的 exe 时会生成），保证压缩包只含启动器文件
  foreach ($junk in @('.minecraft','NaiWa','logs','config','meta','downloads','libraries','versions','assets','instances','java')) {
    $jp = Join-Path $stage ('naiwa\' + $junk)
    if (Test-Path $jp) { Remove-Item $jp -Recurse -Force }
  }
  Get-ChildItem (Join-Path $stage 'naiwa') -Filter '*.log' -File -ErrorAction SilentlyContinue | Remove-Item -Force
$guide = @(
  '奶娃启动器 NaiWa Launcher ' + $version + ' · 免安装版',
  '',
  '1. 把压缩包解压到任意可写目录（例如 D:\Games），得到 naiwa 文件夹。',
  '2. 双击 naiwa\NaiWa Launcher.exe 启动，无需安装、无需管理员权限。',
  '3. 首次启动会在 naiwa 下自动生成：',
  '     .minecraft\   游戏数据（versions / libraries / assets / instances）',
  '     NaiWa\        启动器数据（config / logs / meta / downloads / java / backgrounds / music）',
  '4. 整个 naiwa 文件夹可随时剪切/复制，数据跟着走；删除即卸载。',
  '5. 请保持 exe 与 resources、locales、*.dll 在一起，不要只拷贝 exe。',
  '',
  '开发者：奶龙　　显示名：NaiWa Launcher（设置内显示「奶娃启动器」）'
)
Set-Content -Path (Join-Path $stage '使用说明.txt') -Value $guide -Encoding UTF8
$out = Join-Path $root ('release\NaiWaLauncher-' + $version + '-portable-x64.zip')
Remove-Item $out -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $out -CompressionLevel Optimal
Write-Output ('zip: ' + $out + '  ' + [math]::Round((Get-Item $out).Length/1MB,1) + 'MB')