using System.Drawing;
using System.Text.Json;
using System.Windows.Forms;

internal sealed class NoActivateForm : Form
{
    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000; return p; } }
}

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length != 4) throw new ArgumentException("Expected identity-file, start-sentinel, end-sentinel, DISPLAY2 x");
        var identityPath = Path.GetFullPath(args[0]);
        var startPath = Path.GetFullPath(args[1]);
        var endPath = Path.GetFullPath(args[2]);
        var x = int.Parse(args[3]);
        var y = 80;
        if (x < 2560 || x + 600 > 4480) throw new ArgumentOutOfRangeException(nameof(args), "Fixture must stay on DISPLAY2.");
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var form = new NoActivateForm { Text = "PRSLOY Backend Failure Fixture", Width = 600, Height = 300, StartPosition = FormStartPosition.Manual, Location = new Point(x, y), FormBorderStyle = FormBorderStyle.FixedDialog, TopMost = true, ShowInTaskbar = true };
        var status = new Label { Name = "fixtureStatus", Text = "Ready", Left = 20, Top = 20, Width = 520, Height = 28 };
        var button = new Button { Name = "fixtureDelayed", AccessibleName = "Start isolated test action", Text = "Start isolated test action", Left = 20, Top = 70, Width = 260, Height = 40 };
        var started = false;
        button.Click += (_, _) => {
            if (started) return;
            started = true;
            status.Text = "Isolated action started";
            File.AppendAllText(startPath, DateTimeOffset.UtcNow.ToString("O") + Environment.NewLine);
            // Keep the fixture action active after the backend process is terminated.
            Thread.Sleep(TimeSpan.FromSeconds(45));
            File.AppendAllText(endPath, DateTimeOffset.UtcNow.ToString("O") + Environment.NewLine);
            status.Text = "Isolated action completed";
        };
        form.Controls.Add(status); form.Controls.Add(button);
        form.Shown += (_, _) => File.WriteAllText(identityPath, JsonSerializer.Serialize(new { pid = Environment.ProcessId, hwnd = form.Handle.ToInt64(), x = form.Left, y = form.Top, width = form.Width, height = form.Height }));
        Application.Run(form);
    }
}
