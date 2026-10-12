# Saves the owner's draft model (Draft model.xlsx) updated for each case, as a new workbook next to it: the case's inputs
# written in (as run_model.ps1 does), every changed cell on Inputs filled yellow with its old value in a comment, the model
# recalculated in full. The owner's workbook itself is opened read-only and never saved.
# Input: the same JSON as run_model.ps1, plus "dir" (where to save) and "names" { id: file name }.
param([string]$in)
$ErrorActionPreference = 'Stop'
$spec = Get-Content -Raw -Encoding UTF8 $in | ConvertFrom-Json
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false
$xl.DisplayAlerts = $false
try {
  foreach ($case in $spec.cases) {
    $wb = $xl.Workbooks.Open($spec.model, 0, $true)
    $inp = $wb.Worksheets.Item('Inputs')
    foreach ($p in $case.inputs.PSObject.Properties) {
      $k = $p.Name.LastIndexOf('!')
      if ($k -lt 0) { $rg = $inp.Range($p.Name) } else { $rg = $wb.Worksheets.Item($p.Name.Substring(0, $k).Trim("'")).Range($p.Name.Substring($k + 1)) }
      if ($k -lt 0 -and $rg.Cells.Count -eq 1) {
        $old = if ($rg.HasFormula) { $rg.Formula } else { $rg.Text }
        if ($rg.Comment -ne $null) { $rg.Comment.Delete() }
        $null = $rg.AddComment("Was: " + $old + " (draft model). Updated for " + $case.id + ", 12 Oct 2026.")
        $rg.Interior.Color = 65535
      }
      if ($p.Value -is [string]) { if ($p.Value.StartsWith('=')) { $rg.Formula = $p.Value } else { $rg.Value2 = $p.Value } }
      else { $rg.Formula = ([double]$p.Value).ToString('R', [Globalization.CultureInfo]::InvariantCulture) }
    }
    $xl.CalculateFull()
    $file = Join-Path $spec.dir $spec.names.($case.id)
    if (Test-Path $file) { Remove-Item $file -Force }
    $wb.SaveAs($file, 51)
    $wb.Close($false)
    "saved " + $file
  }
}
catch {
  "ERROR at line " + $_.InvocationInfo.ScriptLineNumber + ": " + $_.Exception.Message
}
finally {
  $xl.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null
}
