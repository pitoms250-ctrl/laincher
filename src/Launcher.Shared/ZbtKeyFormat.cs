using System.Text;

namespace Launcher.Shared;

public static class ZbtKeyFormat
{
    public const string Prefix = "FZBT";
    public const string Alphabet = "23456789ABCDEFGHJKLMNPQRSTVWXYZ";
    public const string FlAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    public static bool TryValidate(string? raw, out string compact, out string error)
    {
        compact = "";
        error = "";
        if (string.IsNullOrWhiteSpace(raw))
        {
            error = "Введите ключ ЗБТ.";
            return false;
        }

        var sb = new StringBuilder(20);
        foreach (var ch in raw.ToUpperInvariant())
        {
            if (char.IsWhiteSpace(ch) || ch is '\u2010' or '\u2011' or '\u2012' or '\u2013' or '\u2014' or '\u2015' or '\u2212') continue;
            if (ch == '-') continue;
            sb.Append(ch);
        }

        var text = sb.ToString();
        if (text.StartsWith("FL", StringComparison.Ordinal))
        {
            var flPayload = text[2..];
            if (flPayload.Length != 12 || flPayload.Any(ch => FlAlphabet.IndexOf(ch) < 0))
            {
                error = "Формат: FL-XXXX-XXXX-XXXX";
                return false;
            }

            compact = text;
            return true;
        }
        if (!text.StartsWith(Prefix, StringComparison.Ordinal) || text.Length != Prefix.Length + 17)
        {
            error = "Формат: FL-XXXX-XXXX-XXXX";
            return false;
        }

        var body = text[Prefix.Length..];
        foreach (var ch in body)
        {
            if (Alphabet.IndexOf(ch) < 0)
            {
                error = "В ключе есть недопустимый символ (не используйте 0, O, 1, I).";
                return false;
            }
        }

        var payload = body[..16];
        var check = body[16];
        if (Checksum(payload) != check)
        {
            error = "Контрольная сумма не совпала — проверьте опечатки.";
            return false;
        }

        compact = text;
        return true;
    }

    public static char Checksum(string payload16)
    {
        var sum = 0;
        for (var i = 0; i < payload16.Length; i++)
        {
            var v = Alphabet.IndexOf(payload16[i]);
            if (v < 0) return '?';
            sum += (i + 1) * (v + 1);
        }
        return Alphabet[sum % Alphabet.Length];
    }
}
