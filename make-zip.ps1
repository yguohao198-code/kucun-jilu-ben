[Console]::OutputEncoding = [Text.Encoding]::UTF8
$n = -join ([char]0x5E93,[char]0x5B58,[char]0x8BB0,[char]0x5F55,[char]0x672C)
$desk = [Environment]::GetFolderPath('Desktop')
$relDir = Join-Path $env:USERPROFILE ($n + '\release')
# 从 release 副本打包（桌面副本可能正被运行中的程序锁住文件；release 副本是无数据的纯净交付版）
$srcDir = Join-Path $relDir $n
$zipName = $n + '_v2.1.zip'
foreach ($base in @($desk, $relDir)) {
  foreach ($v in @('_v1.0.zip', '_v1.1.zip', '_v1.2.zip', '_v1.3.zip', '_v1.4.zip', '_v1.5.zip', '_v1.6.zip', '_v1.7.zip', '_v1.8.zip', '_v1.9.zip', '_v1.10.zip', '_v2.0.zip')) {
    $f = Join-Path $base ($n + $v)
    if (Test-Path $f) { Remove-Item $f -Force; Write-Host ('deleted: ' + $f) }
  }
}
Write-Host ('zipping: ' + $srcDir)
$tmpZip = Join-Path $env:TEMP ('tmp-' + [guid]::NewGuid().ToString('N') + '.zip')
Compress-Archive -Path $srcDir -DestinationPath $tmpZip -CompressionLevel Optimal
Copy-Item $tmpZip (Join-Path $desk $zipName) -Force
Copy-Item $tmpZip (Join-Path $relDir $zipName) -Force
Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
Get-Item (Join-Path $desk $zipName), (Join-Path $relDir $zipName) | ForEach-Object { Write-Host ($_.FullName + ' | ' + [math]::Round($_.Length/1MB,1) + ' MB') }
Write-Host 'ZIP DONE'
