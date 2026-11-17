$desktop = [Environment]::GetFolderPath('Desktop')
$shortcut = Join-Path $desktop '库存记录本.lnk'
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($shortcut)
$s.TargetPath = Join-Path $PSScriptRoot '库存记录本.exe'
$s.WorkingDirectory = $PSScriptRoot
$s.IconLocation = (Join-Path $PSScriptRoot '库存记录本.exe') + ',0'
$s.Save()
Write-Host ''
Write-Host '桌面快捷方式已创建！以后双击桌面上的「库存记录本」图标就能打开。'
