$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
$sourceRoot = Join-Path $repoRoot "src\Launcher.UI\imge\shop"
$outputRoot = Join-Path $repoRoot "src\Launcher.UI\Assets\Shop"

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing.dll -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

public static class ShopSheetCropper
{
    public static void Crop(string sourcePath, string destinationPath, int column, int row, int columns, int rows, bool blackKey)
    {
        Bitmap source = null;
        Bitmap cropped = null;
        Bitmap output = null;
        try
        {
            source = new Bitmap(sourcePath);
            var cellWidth = source.Width / columns;
            var cellHeight = source.Height / rows;
            var left = column * cellWidth + 8;
            var top = row * cellHeight + 8;
            var width = cellWidth - 16;
            var height = cellHeight - 16;
            cropped = new Bitmap(width, height, PixelFormat.Format32bppArgb);

            for (var y = 0; y < height; y++)
            {
                for (var x = 0; x < width; x++)
                {
                    var color = source.GetPixel(left + x, top + y);
                    var alpha = 255;
                    if (blackKey)
                    {
                        if (Math.Max(color.R, Math.Max(color.G, color.B)) < 14) alpha = 0;
                    }
                    else
                    {
                        var matteOpacity = Math.Max(255 - color.R, Math.Max(color.G, 255 - color.B));
                        if (matteOpacity <= 14)
                        {
                            alpha = 0;
                        }
                        else if (matteOpacity < 245)
                        {
                            alpha = matteOpacity;
                            var opacity = alpha / 255.0;
                            var inverse = 1.0 - opacity;
                            var red = Unmatte(color.R, 255, inverse, opacity);
                            var green = Unmatte(color.G, 0, inverse, opacity);
                            var blue = Unmatte(color.B, 255, inverse, opacity);
                            cropped.SetPixel(x, y, Color.FromArgb(alpha, red, green, blue));
                            continue;
                        }
                    }
                    cropped.SetPixel(x, y, Color.FromArgb(alpha, color.R, color.G, color.B));
                }
            }

            System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(destinationPath));
            output = new Bitmap(512, 512, PixelFormat.Format32bppArgb);
            using (var graphics = Graphics.FromImage(output))
            {
                graphics.CompositingQuality = CompositingQuality.HighQuality;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.SmoothingMode = SmoothingMode.HighQuality;
                graphics.DrawImage(cropped, new Rectangle(0, 0, 512, 512));
            }
            output.Save(destinationPath, ImageFormat.Png);
        }
        finally
        {
            if (output != null) output.Dispose();
            if (cropped != null) cropped.Dispose();
            if (source != null) source.Dispose();
        }
    }

    private static int Unmatte(int channel, int matte, double inverse, double opacity)
    {
        return Math.Max(0, Math.Min(255, (int)Math.Round((channel - matte * inverse) / opacity)));
    }
}
'@

$created = 0
function Add-GridAssets {
    param([string[]]$Ids, [string]$File, [int]$Columns, [int]$Rows, [switch]$BlackKey, [int[]]$Indices)
    $source = Join-Path $sourceRoot $File
    if (-not (Test-Path $source)) { throw "Missing sprite sheet: $source" }
    for ($position = 0; $position -lt $Ids.Count; $position++) {
        $index = if ($Indices -and $position -lt $Indices.Count) { $Indices[$position] } else { $position }
        $column = $index % $Columns
        $row = [Math]::Floor($index / $Columns)
        if ($row -ge $Rows) { throw "Grid has too few cells for $($Ids[$position]) in $File." }
        $seedItem = $script:items.PSObject.Properties[$Ids[$position]].Value
        $relative = $seedItem.assets.icon.Substring(5).Replace('/', '\')
        $target = Join-Path $outputRoot $relative
        [ShopSheetCropper]::Crop($source, $target, $column, $row, $Columns, $Rows, $BlackKey.IsPresent)
        $script:created++
    }
}

$script:items = Get-Content (Join-Path $repoRoot "shop_items.seed.json") -Raw | ConvertFrom-Json
Add-GridAssets @("coins_50", "coins_100", "coins_250", "coins_500", "coins_1000") "Game_item_sprite_sheet_5b514b5f.jpg" 3 3 -Indices @(0,1,2,3,4)
Add-GridAssets @("premium_30", "premium_90", "premium_365") "Game_item_sprite_sheet_00257ec9.jpg" 3 3 -Indices @(0,1,2)
Add-GridAssets @("tag_custom", "tag_short", "tag_colored", "tag_animated") "Game_item_sprite_sheet_00257ec9.jpg" 3 3 -Indices @(3,4,5,6)
Add-GridAssets @("cape_fl_classic", "cape_fox_tail", "cape_emerald_wings", "cape_void", "cape_aurora", "cape_dragon", "cape_golden_legend", "cape_halloween_2026", "cape_winter_2026") "Game_item_sprite_sheet_affa763a.jpg" 3 3
Add-GridAssets @("frame_fl_emerald", "frame_fl_neon", "frame_fl_gold", "frame_fl_diamond", "frame_fl_fire", "frame_fl_rainbow", "frame_fl_premium", "frame_halloween_2026", "frame_winter_2026") "Game_item_sprite_sheet_00257ec9.jpg" 3 3 -Indices @(7,4,2,3,4,2,7,5,5)
Add-GridAssets @("nick_emerald", "nick_fire", "nick_ice", "nick_rainbow") "Game_item_sprite_sheet_585908d0.jpg" 4 2 -Indices @(0,1,2,3)
Add-GridAssets @("effect_pulse", "effect_glow", "effect_sparkle") "Game_UI_effects_grid_sheet_0a475e06.jpg" 3 2 -BlackKey -Indices @(0,1,2)
Add-GridAssets @("badge_fox", "badge_builder", "badge_pvp", "badge_creator", "badge_early_supporter", "badge_halloween_2026", "badge_winter_2026") "Game_item_badge_sprite_sheet_24b2f5a7.jpg" 3 3 -Indices @(0,1,2,3,4,5,6)
Add-GridAssets @("banner_forest", "banner_castle", "banner_neon_city", "banner_aurora") "Game_items_sprite_sheet_176066f7.jpg" 2 2
Add-GridAssets @("theme_amber", "theme_sakura", "theme_cyber", "theme_midnight") "Game_item_sprite_sheet_8822476b.jpg" 3 2 -Indices @(0,1,2,3)
Add-GridAssets @("emoji_fox") "Game_item_sprite_sheet_8822476b.jpg" 3 2 -Indices @(4)
Add-GridAssets @("case_rare", "case_epic", "case_legendary", "case_cape", "case_frame", "case_halloween_2026", "case_winter_2026", "case_pack_5") "Game_item_chests_sprite_sheet_577b2c84.jpg" 3 3 -Indices @(1,2,3,4,5,6,7,8)
$basicCase = $script:items.PSObject.Properties["case_basic"].Value
$basicCasePath = Join-Path $outputRoot $basicCase.assets.icon.Substring(5).Replace('/', '\')
[ShopSheetCropper]::Crop((Join-Path $sourceRoot "Emerald_loot_crate_sitting_74910f4a_2K.jpg"), $basicCasePath, 0, 0, 1, 1, $false)
$created++
Add-GridAssets @("gift_premium_30", "gift_coins_100", "gift_coins_500", "gift_box_surprise") "Game_item_sprite_sheet_bd0c0d9a.jpg" 3 3 -Indices @(0,1,2,3)
Add-GridAssets @("bundle_starter", "bundle_fox", "bundle_legend") "Game_item_sprite_sheet_bd0c0d9a.jpg" 3 3 -Indices @(4,5,7)

foreach ($caseId in @("case_basic", "case_rare", "case_epic", "case_legendary", "case_cape", "case_frame", "case_halloween_2026", "case_winter_2026")) {
    $source = Join-Path $sourceRoot "Open_chest_item_sprite_sheet_ad13e713.jpg"
    $index = @("case_basic", "case_rare", "case_epic", "case_legendary", "case_cape", "case_frame", "case_halloween_2026", "case_winter_2026").IndexOf($caseId)
    $column = $index % 3
    $row = [Math]::Floor($index / 3)
    $seedItem = $script:items.PSObject.Properties[$caseId].Value
    $relative = $seedItem.assets.iconOpen.Substring(5).Replace('/', '\')
    [ShopSheetCropper]::Crop($source, (Join-Path $outputRoot $relative), $column, $row, 3, 3, $false)
    $created++
}

Write-Host "Created PNG icons: $created"
Write-Host "Resource folder: $outputRoot"
