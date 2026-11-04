using System.Drawing;
using System.Windows.Forms;

// Munim exercises this fixture through UI Automation. It must never activate or
// redirect keyboard input away from the user's active window.
internal sealed class NoActivateForm : Form
{
    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var value = base.CreateParams;
            value.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            return value;
        }
    }
}

internal static class Program
{
    private const int Display2Left = 2560;
    private const int Display2Right = 4480;
    private const int Display2Bottom = 1080;
    private const int FixtureWidth = 560;
    private const int FixtureHeight = 300;
    private const int SideEffectDelaySeconds = 25;

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length != 3)
            throw new ArgumentException("Expected exactly: <output-file-in-temp> <display2-x> <display2-y>");

        var outputPath = Path.GetFullPath(args[0]);
        var x = int.Parse(args[1]);
        var y = int.Parse(args[2]);
        EnsureTempOutputPath(outputPath);

        // This user's approved DISPLAY2 begins at X=2560. A caller must supply
        // explicit coordinates; the fixture refuses default/primary-screen placement.
        if (x < Display2Left || x > Display2Right - FixtureWidth || y < 0 || y > Display2Bottom - FixtureHeight)
            throw new ArgumentOutOfRangeException(nameof(args), "The full fixture window must fit inside DISPLAY2.");

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var form = new NoActivateForm
        {
            Text = "PRSLOY 104 Munim Isolated Fixture",
            Width = FixtureWidth,
            Height = FixtureHeight,
            StartPosition = FormStartPosition.Manual,
            Location = new Point(x, y),
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            ShowInTaskbar = true,
            TopMost = true,
        };

        var status = new Label
        {
            Name = "fixtureStatus",
            Text = "Ready",
            Left = 20,
            Top = 20,
            Width = 500,
            Height = 28,
        };
        var input = new TextBox
        {
            Name = "fixtureInput",
            AccessibleName = "Test text",
            Left = 20,
            Top = 60,
            Width = 500,
        };
        var save = new Button
        {
            Name = "fixtureSave",
            AccessibleName = "Save test marker",
            Text = "Save test marker",
            Left = 20,
            Top = 100,
            Width = 180,
            Height = 36,
        };
        save.Click += (_, _) =>
        {
            File.WriteAllText(outputPath, input.Text);
            status.Text = "Saved: " + input.Text;
        };

        var delayed = new Button
        {
            Name = "fixtureDelayed",
            AccessibleName = "Start delayed side effect",
            Text = "Start delayed side effect",
            Left = 20,
            Top = 152,
            Width = 240,
            Height = 36,
        };
        var actionStarted = false;
        delayed.Click += (_, _) =>
        {
            // A second click cannot create a concurrent effect in this fixture.
            if (actionStarted) return;
            actionStarted = true;
            var startPath = outputPath + ".start";
            var endPath = outputPath + ".end";
            status.Text = "Delayed action started";
            File.WriteAllText(startPath, DateTimeOffset.UtcNow.ToString("O"));

            // Keep this native UIA action in flight while Stop is exercised.
            // The button handler returns only after the external side effect completes.
            Thread.Sleep(TimeSpan.FromSeconds(SideEffectDelaySeconds));
            File.WriteAllText(outputPath + ".delayed-result", "completed");
            File.WriteAllText(endPath, DateTimeOffset.UtcNow.ToString("O"));
            status.Text = "Delayed action completed";
        };

        form.Controls.Add(status);
        form.Controls.Add(input);
        form.Controls.Add(save);
        form.Controls.Add(delayed);
        Application.Run(form);
    }

    private static void EnsureTempOutputPath(string outputPath)
    {
        var tempRoot = Path.GetFullPath(Path.GetTempPath());
        var relative = Path.GetRelativePath(tempRoot, outputPath);
        if (Path.IsPathRooted(relative) || relative == "." || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new ArgumentException("Fixture output must be a file below the current user's temporary directory.", nameof(outputPath));

        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
    }
}
