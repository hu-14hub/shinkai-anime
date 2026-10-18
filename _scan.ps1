$f = 'c:\Users\pc\Downloads\Project 2\anime-stream\src\components\video-player.tsx'
$pat = 'fmt\(|\bseek\(|togglePlay|defaultSub|remaining|inIntro|inOutro|activeSub|bufferedSet|progressPct'
Select-String -Path $f -Pattern $pat | ForEach-Object { $_.LineNumber.ToString() + ': ' + $_.Line.Trim() }