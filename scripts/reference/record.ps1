param([string]$Name, [double]$Seconds = 45, [uint32]$GamePid, [switch]$Play)
# Records the screen (Desktop Duplication, 60 fps, x264 ultrafast) and the system audio (WASAPI
# loopback) together; optionally lets the bot play meanwhile. Desktop Duplication drops when the game
# reloads, so the video is taken in segments (<Name>-v0.mp4, -v1...) restarted until the time is up;
# <Name>.txt has the wall-clock start of every segment and of the audio, for alignment.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = 'F:/Projects/Web/TetrisEffect/reference-capture/te-clips'
New-Item -ItemType Directory -Force $out | Out-Null
$wav = Join-Path $out "$Name.wav"
$log = Join-Path $out "$Name.txt"
$player = $null
if ($Play) {
  $player = Start-Process -FilePath 'python' -ArgumentList @('-I', "`"$(Join-Path $here 'bot.py')`"", "$GamePid", "$Seconds") -PassThru -WindowStyle Hidden
}
$audioJob = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-Command', "Add-Type -Path '$(Join-Path $here 'TeTools.cs')'; [TeTools.Loopback]::Record('$wav', $($Seconds + 1.0)) | Set-Content '$log.audio'") -PassThru -WindowStyle Hidden
$start = Get-Date
$lines = @()
$k = 0
while (((Get-Date) - $start).TotalSeconds -lt $Seconds - 1) {
  $remaining = [math]::Round($Seconds - ((Get-Date) - $start).TotalSeconds, 2)
  $mp4 = Join-Path $out "$Name-v$k.mp4"
  $t0 = Get-Date
  $ff = Start-Process -FilePath 'ffmpeg' -ArgumentList @('-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'ddagrab=framerate=60:draw_mouse=0,hwdownload,format=bgra', '-t', "$remaining", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '19', '-pix_fmt', 'yuv420p', "`"$mp4`"") -PassThru -WindowStyle Hidden
  $ff.WaitForExit()
  $lines += "segment $k started $($t0.ToUniversalTime().ToString('o')) lasted $([math]::Round(((Get-Date) - $t0).TotalSeconds, 2)) s"
  $k++
  [System.Threading.Thread]::Sleep(300)
}
$audioJob.WaitForExit()
if ($player) { $player.WaitForExit() }
$lines += "audio $(Get-Content "$log.audio")"
$lines | Set-Content $log
Remove-Item "$log.audio" -ErrorAction SilentlyContinue
Get-Content $log
