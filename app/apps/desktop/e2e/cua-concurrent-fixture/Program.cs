using System.Drawing;
using System.Windows.Forms;

// These surfaces are deliberately non-activating: the test must not steal
// keyboard focus from the person running it.
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
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length != 5) throw new ArgumentException("Expected title, output, start marker, x, y");
        var title = args[0];
        var output = Path.GetFullPath(args[1]);
        var startMarker = Path.GetFullPath(args[2]);
        var x = int.Parse(args[3]);
        var y = int.Parse(args[4]);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var form = new NoActivateForm
        {
            Text = title,
            Width = 540,
            Height = 300,
            StartPosition = FormStartPosition.Manual,
            Location = new Point(x, y),
        };
        var status = new Label { Name = "fixtureStatus", Text = "Ready", Left = 20, Top = 20, Width = 480, Height = 28 };
        var delayed = new Button
        {
            Name = "fixtureDelayed",
            Text = "Start delayed side effect",
            AccessibleName = "Start delayed side effect",
            Left = 20,
            Top = 72,
            Width = 250,
            Height = 40,
        };
        delayed.Click += (_, _) =>
        {
            Directory.CreateDirectory(Path.GetDirectoryName(startMarker)!);
            File.AppendAllText(startMarker, "write-ahead recorded\n" + DateTime.UtcNow.ToString("O") + "\n");
            status.Text = "Delayed action is in progress";
            // Keep the external UI action outstanding long enough to open a second chat.
            Thread.Sleep(TimeSpan.FromSeconds(18));
            File.WriteAllText(output, "A-effect-completed");
            status.Text = "Delayed action completed";
        };
        var save = new Button
        {
            Name = "fixtureSave",
            Text = "Save B effect",
            AccessibleName = "Save B effect",
            Left = 20,
            Top = 130,
            Width = 180,
            Height = 38,
        };
        save.Click += (_, _) => File.WriteAllText(output, "B-effect-executed");
        form.Controls.Add(status);
        form.Controls.Add(delayed);
        form.Controls.Add(save);
        Application.Run(form);
    }
}
