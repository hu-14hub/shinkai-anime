$f = 'c:\Users\pc\Downloads\Project 2\anime-stream\src\components\video-player.tsx'
$raw = [System.IO.File]::ReadAllBytes($f)
Write-Output ('FirstByte=' + $raw[0])
$text = [System.IO.File]::ReadAllText($f)
Write-Output ('HasCR=' + ($text.IndexOf([char]13) -gt 0))
$lines = $text -split "`n"
Write-Output ('LineCount=' + $lines.Count)
foreach ($i in 0..6) { Write-Output ('Line' + ($i+1) + 'Len=' + $lines[$i].Length + ' : ' + ($lines[$i] -replace "`r",'')) }