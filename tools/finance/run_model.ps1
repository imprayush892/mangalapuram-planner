# Runs the owner's draft financial model (Draft model.xlsx) once per case and reads its One-Page Summary.
# Input: a JSON file { "model": path, "cases": [ { "id": "D1", "inputs": { "C33": 0.117, ... } }, ... ] }
# (cells on the Inputs sheet; an empty inputs map runs the model as given). The workbook is opened read-only
# and closed without saving: nothing is written to it.
# Output: a JSON file { "D1": { "<cell>": { "t": text, "v": value }, ... }, ... }.
param([string]$in, [string]$out)
$ErrorActionPreference = 'Stop'
$spec = Get-Content -Raw -Encoding UTF8 $in | ConvertFrom-Json
$cells = 'C4','D4','E4','F4','G4','H4','I4','J4','K4','L4','M4','N4',
         'C5','D5','E5','F5','G5','H5','I5','J5','K5','L5','M5','N5',
         'K8','K9','K10','K12','K13',
         'D9','D10','D11','D12','D13','D14','D15','D16','D17','D18','D19','D20',
         'E24','J24','L24','E25','F25','J25','K25','L25','M25','E26','J26','J27','J28','J29','J30','J34','K34','L34',
         'L35','L36','L37','L38','L39','D67','E67','J67','K67'
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false
$xl.DisplayAlerts = $false
$res = [ordered]@{}
try {
  foreach ($case in $spec.cases) {
    $wb = $xl.Workbooks.Open($spec.model, 0, $true)
    $inp = $wb.Worksheets.Item('Inputs')
    foreach ($p in $case.inputs.PSObject.Properties) {
      $inp.Range($p.Name).Formula = ([double]$p.Value).ToString('R', [Globalization.CultureInfo]::InvariantCulture)
    }
    $xl.CalculateFull()
    $s = $wb.Worksheets.Item('One-Page Summary')
    $o = [ordered]@{}
    foreach ($c in $cells) { $o[$c] = @{ t = $s.Range($c).Text; v = $s.Range($c).Value2 } }
    $res[$case.id] = $o
    $wb.Close($false)
  }
  $res | ConvertTo-Json -Depth 5 | Out-File -FilePath $out -Encoding utf8
  "ok " + $spec.cases.Count
}
catch {
  "ERROR at line " + $_.InvocationInfo.ScriptLineNumber + ": " + $_.Exception.Message
}
finally {
  $xl.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null
}
