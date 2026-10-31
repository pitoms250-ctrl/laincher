namespace Launcher.Core.Models;

public sealed record ZbtAccessResult(bool Ok, string? CampaignId, string Message, bool OtherDevice = false, bool LockedOut = false);
