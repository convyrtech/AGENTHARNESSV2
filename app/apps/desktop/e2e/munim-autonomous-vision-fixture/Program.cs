using System.Drawing;
using System.Windows.Forms;

internal sealed class NoActivateVisionForm : Form
{
    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams
    {
        get { var p = base.CreateParams; p.ExStyle |= 0x08000000; return p; }
    }
}

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length != 4) throw new ArgumentException("Expected marker, output path, x, y");
        var marker = args[0];
        var output = Path.GetFullPath(args[1]);
        var x = int.Parse(args[2]);
        var y = int.Parse(args[3]);
        var temp = Path.GetFullPath(Path.GetTempPath());
        var rel = Path.GetRelativePath(temp, output);
        if (Path.IsPathRooted(rel) || rel == "." || rel.StartsWith(".." + Path.DirectorySeparatorChar))
            throw new ArgumentException("Output must remain in the temporary directory");
        if (x < 2560 || x + 560 > 4480 || y < 0 || y + 300 > 1032)
            throw new ArgumentOutOfRangeException(nameof(args), "Fixture must fit on DISPLAY2");

        Application.EnableVisualStyles();
        var form = new NoActivateVisionForm
        {
            Text = "PRSLOY 104 Munim Vision Fixture",
            Width = 560,
            Height = 300,
            StartPosition = FormStartPosition.Manual,
            Location = new Point(x, y),
            FormBorderStyle = FormBorderStyle.FixedDialog,
            ShowInTaskbar = true,
            TopMost = true,
            BackColor = Color.White,
        };
        form.Paint += (_, e) =>
        {
            e.Graphics.DrawString("Visual check", new Font("Arial", 16), Brushes.Black, 20, 25);
            e.Graphics.DrawString(marker, new Font("Consolas", 28, FontStyle.Bold), Brushes.DarkBlue, 20, 100);
        };
        form.FormClosed += (_, _) => File.WriteAllText(output, "closed");
        Application.Run(form);
    }
}
