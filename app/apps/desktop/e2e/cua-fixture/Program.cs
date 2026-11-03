using System.Drawing;
using System.Windows.Forms;

// The fixture lives on DISPLAY2 and must never take keyboard focus from the owner.
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
        if (args.Length < 3) throw new ArgumentException("Expected output path and explicit display coordinates");
        var output = Path.GetFullPath(args[0]);
        var x = int.Parse(args[1]);
        var y = int.Parse(args[2]);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var form = new NoActivateForm { Text = "PRSLOY 104 Packaged Cua Fixture", Width = 560, Height = 340, StartPosition = FormStartPosition.Manual, Location = new Point(x, y) };
        var status = new Label { Name = "fixtureStatus", Text = "Ready", Left = 24, Top = 24, Width = 480, Height = 28 };
        var input = new TextBox { Name = "fixtureInput", Left = 24, Top = 72, Width = 480, AccessibleName = "Test text" };
        var save = new Button { Name = "fixtureSave", Text = "Save test marker", Left = 24, Top = 120, Width = 180, Height = 36, AccessibleName = "Save test marker" };
        save.Click += (_, _) => {
            Directory.CreateDirectory(Path.GetDirectoryName(output)!);
            File.WriteAllText(output, input.Text);
            status.Text = "Saved: " + input.Text;
        };
        var delayed = new Button { Name = "fixtureDelayed", Text = "Start delayed side effect", Left = 24, Top = 176, Width = 240, Height = 36, AccessibleName = "Start delayed side effect" };
        delayed.Click += (_, _) => {
            var startPath = output + ".start";
            var resultPath = output + ".delayed-result";
            Directory.CreateDirectory(Path.GetDirectoryName(output)!);
            File.AppendAllText(startPath, "started\n" + DateTime.UtcNow.ToString("O") + "\n");
            status.Text = "Delayed side effect started";
            Thread.Sleep(TimeSpan.FromSeconds(25));
            File.WriteAllText(resultPath, "completed");
            status.Text = "Delayed side effect completed";
        };
        form.Controls.Add(status);
        form.Controls.Add(input);
        form.Controls.Add(save);
        form.Controls.Add(delayed);
        if (args.Length > 3 && args[3] == "--two")
        {
            var second = new NoActivateForm
            {
                Text = "PRSLOY 104 Packaged Cua Fixture Secondary",
                Width = 420,
                Height = 180,
                StartPosition = FormStartPosition.Manual,
                Location = new Point(x + 600, y),
            };
            second.Controls.Add(new Label { Text = "Secondary window; never interact with this fixture surface.", Left = 16, Top = 24, Width = 380, Height = 48 });
            second.Show();
        }
        Application.Run(form);
    }
}
