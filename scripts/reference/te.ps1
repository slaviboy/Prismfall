param(
  [Parameter(Mandatory = $true)][string]$Cmd,
  [string]$Arg = '',
  [double]$Seconds = 10,
  [int]$Gap = 120,
  [string]$Proc = 'TetrisEffect-Win64-Shipping'
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not ('TeTools.Keys' -as [type])) {
  Add-Type -Path (Join-Path $here 'TeTools.cs')
}
switch ($Cmd) {
  'audio' { [TeTools.Loopback]::Record($Arg, $Seconds) }
  'keys' {
    [TeTools.Keys]::Focus($Proc) | Out-Null
    [TeTools.Keys]::Sequence($Arg, $Gap)
  }
  'focus' { [TeTools.Keys]::Focus($Proc) }
  'shot' {
    & ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'ddagrab=framerate=10:draw_mouse=0,hwdownload,format=bgra' -frames:v 1 -update 1 $Arg
    "saved $Arg"
  }
  default { "unknown command $Cmd" }
}
