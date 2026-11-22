# Alat uji: membuka file .xlsx di instance Excel sendiri (tidak terlihat),
# mengubah satu sel, menyimpan dengan Ctrl+S biasa (Save), lalu menutupnya.
# Dipakai scripts/smoke-docs-e2e.mjs supaya pola simpan Excel yang asli
# (file sementara, rename, kunci ~$) teruji tanpa menyentuh Excel milik user.
# Hanya proses Excel yang dibuat skrip ini yang ditutup.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Value = "Diubah oleh uji",
  [int]$HoldSeconds = 0
)
$ErrorActionPreference = 'Stop'
$before = @(Get-Process EXCEL -ErrorAction SilentlyContinue | ForEach-Object Id)
$excel = New-Object -ComObject Excel.Application
$mine = @(Get-Process EXCEL -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | ForEach-Object Id)
try {
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $wb = $excel.Workbooks.Open($Path)
  if ($HoldSeconds -gt 0) { Start-Sleep -Seconds $HoldSeconds }
  $wb.Worksheets.Item(1).Cells.Item(3, 1).Value2 = $Value
  $wb.Save()
  if ($HoldSeconds -gt 0) { Start-Sleep -Seconds $HoldSeconds }
  $wb.Close($false)
} finally {
  $excel.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
  Start-Sleep -Seconds 2
  foreach ($id in $mine) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}
Write-Output "saved"
