using System.Text.RegularExpressions;
using Launcher.Core.Models;

namespace Launcher.Core;

/// <summary>Правила Mojang (libraries[].rules / arguments[].rules). Платформа — Windows x64.</summary>
public static class RuleEvaluator
{
    public static bool IsAllowed(IReadOnlyList<Rule>? rules)
    {
        if (rules is null || rules.Count == 0) return true;
        bool allowed = false;
        foreach (var r in rules)
            if (Matches(r)) allowed = r.Action == "allow";
        return allowed;
    }

    private static bool Matches(Rule r)
    {
        if (r.Features is { Count: > 0 }) return false; // демо/кастомное разрешение не включаем
        if (r.Os is null) return true;
        if (r.Os.Name is not null && r.Os.Name != "windows") return false;
        if (r.Os.Arch is not null && r.Os.Arch == "x86" && Environment.Is64BitOperatingSystem) return false;
        if (r.Os.Version is not null && !Regex.IsMatch(Environment.OSVersion.Version.ToString(), r.Os.Version)) return false;
        return true;
    }
}
