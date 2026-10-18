$f = 'c:\Users\pc\Downloads\Project 2\anime-stream\src\i18n\dictionaries\en.json'
$l = Get-Content -LiteralPath $f
$i = 0
foreach ($line in $l) {
  $i++
  if ($line -match '"player":') {
    for ($j = $i-1; $j -lt $i+50 -and $j -lt $l.Count; $j++) {
      Write-Output ("{0}|{1}" -f ($j+1), $l[$j])
    }
    break
  }
}