using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("Поток — сверка счетов")]
[assembly: AssemblyProduct("Поток")]
[assembly: AssemblyVersion("1.5.2.0")]
[assembly: AssemblyFileVersion("1.5.2.0")]

static class Program
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryEx(string path, IntPtr reserved, uint flags);

    private static readonly Assembly Package = Assembly.GetExecutingAssembly();
    internal static readonly string DataDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SevernayaYagoda");

    [STAThread]
    public static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string session = Path.Combine(DataDirectory, "sessions", Guid.NewGuid().ToString("N"));
        string ui = Path.Combine(session, "ui");
        string page = Path.Combine(ui, "index.html");
        string core = Path.Combine(session, "severnaya-yagoda-core.exe");
        try
        {
            if (args.Length == 1 && args[0] == "--licenses")
            {
                ShowLicenses();
                return;
            }
            Directory.CreateDirectory(ui);
            WriteResource("Pilot.html", page);
            WriteResource("PilotCore.exe", core);
            string loader = InstallLoader();
            if (LoadLibraryEx(loader, IntPtr.Zero, 0x1100) == IntPtr.Zero)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            AppDomain.CurrentDomain.AssemblyResolve += ResolveWebViewAssembly;
            RunWindow(ui, core, args);
        }
        catch (Exception problem)
        {
            Environment.ExitCode = 1;
#if VERIFY
            if (args.Length == 2) { File.WriteAllText(args[1], problem.ToString()); return; }
#endif
            MessageBox.Show(problem.Message, "Поток", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            TryDelete(page);
            TryDelete(core);
            TryDeleteDirectory(ui);
            TryDeleteDirectory(session);
        }
    }

    private static Assembly ResolveWebViewAssembly(object sender, ResolveEventArgs args)
    {
        string name = new AssemblyName(args.Name).Name;
        if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms") return null;
        using (Stream resource = Package.GetManifestResourceStream(name + ".dll"))
        using (var bytes = new MemoryStream())
        {
            resource.CopyTo(bytes);
            return Assembly.Load(bytes.ToArray());
        }
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void RunWindow(string ui, string executable, string[] args)
    {
        using (var core = new RustSession(executable))
        using (var window = new PilotWindow(ui, core, args))
            Application.Run(window);
    }

    private static void WriteResource(string name, string path)
    {
        using (Stream resource = Package.GetManifestResourceStream(name))
        using (var file = new FileStream(path, FileMode.CreateNew))
            resource.CopyTo(file);
    }

    private static string InstallLoader()
    {
        string directory = Path.Combine(DataDirectory, "runtime-1.0.4314.35");
        Directory.CreateDirectory(directory);
        string loader = Path.Combine(directory, "WebView2Loader.dll");
        byte[] embedded;
        using (Stream resource = Package.GetManifestResourceStream("WebView2Loader.dll"))
        using (var bytes = new MemoryStream())
        {
            resource.CopyTo(bytes);
            embedded = bytes.ToArray();
        }
        if (!File.Exists(loader))
        {
            string staging = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                File.WriteAllBytes(staging, embedded);
                try { File.Move(staging, loader); }
                catch (IOException) { if (!File.Exists(loader)) throw; }
            }
            finally { TryDelete(staging); }
        }
        if (!File.ReadAllBytes(loader).SequenceEqual(embedded))
            throw new IOException("Повреждён компонент WebView2. Переименуйте папку " + directory + " и запустите приложение снова.");
        return loader;
    }

    private static void ShowLicenses()
    {
        using (var form = new Form { Text = "Лицензии компонентов", ClientSize = new Size(680, 450) })
        using (var license = new StreamReader(Package.GetManifestResourceStream("License.txt")))
        using (var notice = new StreamReader(Package.GetManifestResourceStream("Notice.txt")))
        using (var rust = new StreamReader(Package.GetManifestResourceStream("RustLicenses.txt")))
        {
            form.Controls.Add(new TextBox
            {
                Dock = DockStyle.Fill, Multiline = true, ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Text = license.ReadToEnd() + "\r\n\r\n" + notice.ReadToEnd() + "\r\n\r\n" + rust.ReadToEnd()
            });
            Application.Run(form);
        }
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static void TryDeleteDirectory(string path)
    {
        try { Directory.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

sealed class PilotWindow : Form
{
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForSystem();

    private const int UseImmersiveDarkMode = 20;
    private const int LogicalDpi = 96;
    private const string HomePage = "https://pilot.local/index.html";
    private const string CasePage = "https://navicons.com/careers/ai-fest-2026/cases/#case-04";
    private readonly string contentDirectory;
    private readonly WebView2 view;
    private readonly RustSession core;
#if VERIFY
    private readonly string[] verification;
#endif

    internal PilotWindow(string directory, RustSession session, string[] args)
    {
        contentDirectory = directory;
        core = session;
#if VERIFY
        verification = args;
        ShowInTaskbar = false;
        Opacity = 0.01;
#endif
        Text = "Поток — сверка счетов";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        StartPosition = FormStartPosition.CenterScreen;
        var work = Screen.PrimaryScreen.WorkingArea;
        uint dpi = GetDpiForSystem();
        ClientSize = new Size(
            Math.Min(ScaleToDpi(1220, dpi), work.Width - ScaleToDpi(48, dpi)),
            Math.Min(ScaleToDpi(820, dpi), work.Height - ScaleToDpi(72, dpi)));
        MinimumSize = new Size(ScaleToDpi(390, dpi), ScaleToDpi(420, dpi));
        view = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(10, 12, 15) };
        Controls.Add(view);
        Shown += Initialize;
    }

    private static int ScaleToDpi(int logicalPixels, uint dpi)
    {
        return (int)Math.Round(logicalPixels * dpi / (double)LogicalDpi);
    }

    private async void Initialize(object sender, EventArgs args)
    {
        try
        {
            SetWindowTheme(true);
            string profile = Path.Combine(Program.DataDirectory, "WebView2");
#if VERIFY
            profile = Path.Combine(Path.GetDirectoryName(verification[1]), "theme-test-" + Guid.NewGuid().ToString("N"));
#endif
            var engine = await CoreWebView2Environment.CreateAsync(null, profile);
            await view.EnsureCoreWebView2Async(engine);
            var browser = view.CoreWebView2;
            browser.Settings.AreDevToolsEnabled = false;
            browser.WebMessageReceived += async delegate(object sender2, CoreWebView2WebMessageReceivedEventArgs message)
            {
                if (message.Source != HomePage) return;
                string data = message.WebMessageAsJson;
                if (data == "\"dark\"") SetWindowTheme(true);
                else if (data == "\"light\"") SetWindowTheme(false);
                else if (data.StartsWith("{", StringComparison.Ordinal))
                {
                    try
                    {
                        string response = await core.SendAsync(data);
                        if (!IsDisposed) browser.PostWebMessageAsJson(response);
                    }
                    catch (Exception)
                    {
                        if (!IsDisposed)
                            browser.PostWebMessageAsJson("{\"core\":true,\"error\":\"Модуль сверки недоступен. Перезапустите приложение.\"}");
                    }
                }
            };
            browser.SetVirtualHostNameToFolderMapping("pilot.local", contentDirectory, CoreWebView2HostResourceAccessKind.DenyCors);
            browser.NavigationStarting += delegate(object sender2, CoreWebView2NavigationStartingEventArgs navigation)
            {
                if (navigation.Uri == HomePage) return;
                navigation.Cancel = true;
                if (navigation.Uri == CasePage)
                    Process.Start(new ProcessStartInfo(CasePage) { UseShellExecute = true });
            };
            browser.NewWindowRequested += delegate(object sender2, CoreWebView2NewWindowRequestedEventArgs request)
            {
                request.Handled = true;
            };
            browser.Navigate(HomePage);
#if VERIFY
            await Verify(browser);
            File.WriteAllText(verification[1], "PASS: per-monitor DPI " + GetDpiForWindow(Handle) + ", startup and skip, reduced motion, animated themes, XLSX analysis, stable row selection, new letter, full Excel download");
            Close();
#endif
        }
        catch (Exception problem)
        {
            Environment.ExitCode = 1;
#if VERIFY
            File.WriteAllText(verification[1], problem.ToString());
#else
            MessageBox.Show(this, "Не удалось запустить приложение. " + problem.Message,
                "Поток", MessageBoxButtons.OK, MessageBoxIcon.Error);
#endif
            Close();
        }
    }

    private void SetWindowTheme(bool dark)
    {
        int value = dark ? 1 : 0;
        DwmSetWindowAttribute(Handle, UseImmersiveDarkMode, ref value, sizeof(int));
        view.DefaultBackgroundColor = dark ? Color.FromArgb(10, 12, 15) : Color.FromArgb(242, 245, 246);
    }

#if VERIFY
    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);

    private async Task Verify(CoreWebView2 browser)
    {
        if (!AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(Handle), new IntPtr(-4)))
            throw new InvalidOperationException("The main window is not Per-Monitor DPI Aware V2.");
        double scale = GetDpiForWindow(Handle) / (double)LogicalDpi;
        string scaleJs = scale.ToString(System.Globalization.CultureInfo.InvariantCulture);
        await Expect(browser, "Math.abs(window.devicePixelRatio - " + scaleJs + ") < .01");
        await Expect(browser, "document.getElementById('startup').open && document.querySelector('.startup-logo-dark').naturalWidth > 0");
        await Expect(browser, "document.querySelector('#startup-typed > .printed') && document.querySelector('#startup-typed > span:not(.printed)')");
        await Expect(browser, "document.getElementById('startup').open && !document.querySelector('#startup-typed > span:not(.printed)')");
        using (var shot = File.Create(Path.ChangeExtension(verification[1], ".startup.png")))
            await browser.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, shot);
        await Expect(browser, "(() => { const intro = document.getElementById('startup'); const alpha = Number(getComputedStyle(intro, '::backdrop').opacity); return intro.open && alpha > 0 && alpha < 1 && getComputedStyle(document.querySelector('.shell')).animationName === 'startup-dashboard-in'; })()");
        using (var shot = File.Create(Path.ChangeExtension(verification[1], ".transition.png")))
            await browser.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, shot);
        await Expect(browser, "!document.getElementById('startup').open");
        await Expect(browser, "!document.getElementById('import-start').hidden && document.getElementById('analysis').hidden && document.querySelectorAll('#rows tr').length === 0");
        await Expect(browser, "document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.documentElement).backgroundColor === 'rgb(10, 12, 15)'");
        await Expect(browser, "getComputedStyle(document.querySelector('.theme-moon')).backgroundColor === 'rgb(13, 186, 204)'");
        using (var shot = File.Create(Path.ChangeExtension(verification[1], ".png")))
            await browser.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, shot);
        await browser.ExecuteScriptAsync("document.getElementById('theme-toggle').click()");
        await Expect(browser, "document.documentElement.matches(':active-view-transition')");
        await Expect(browser, "document.getElementById('theme-toggle').getAttribute('aria-checked') === 'true' && getComputedStyle(document.documentElement).backgroundColor === 'rgb(242, 245, 246)'");
        await Expect(browser, "!document.documentElement.matches(':active-view-transition')");
        await Expect(browser, "getComputedStyle(document.querySelector('.theme-sun')).backgroundColor === 'rgb(13, 186, 204)'");
        using (var shot = File.Create(Path.ChangeExtension(verification[1], ".light.png")))
            await browser.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, shot);
        var reloaded = new TaskCompletionSource<bool>();
        EventHandler<CoreWebView2NavigationCompletedEventArgs> complete = (sender, args) => reloaded.TrySetResult(args.IsSuccess);
        browser.NavigationCompleted += complete;
        browser.Reload();
        await Task.WhenAny(reloaded.Task, Task.Delay(6000));
        browser.NavigationCompleted -= complete;
        if (!reloaded.Task.IsCompleted || !reloaded.Task.Result) throw new InvalidOperationException("Reload failed");
        await Expect(browser, "document.getElementById('analysis').hidden && document.documentElement.dataset.theme === 'light'");
        await Expect(browser, "document.getElementById('startup').open && document.querySelector('.startup-logo-light').naturalWidth > 0");
        using (var shot = File.Create(Path.ChangeExtension(verification[1], ".startup-light.png")))
        {
            await Expect(browser, "!document.querySelector('#startup-typed > span:not(.printed)')");
            await browser.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, shot);
        }
        browser.Reload();
        await Expect(browser, "document.getElementById('startup').open && document.querySelector('#startup-typed > span:not(.printed)')");
        await browser.ExecuteScriptAsync("document.getElementById('startup-skip').click()");
        await Expect(browser, "document.getElementById('startup').matches('[open].closing')");
        await Expect(browser, "!document.getElementById('startup').open");
        await browser.ExecuteScriptAsync("document.getElementById('theme-toggle').click()");
        await Expect(browser, "document.getElementById('theme-toggle').getAttribute('aria-checked') === 'false' && getComputedStyle(document.documentElement).backgroundColor === 'rgb(10, 12, 15)'");

        await browser.CallDevToolsProtocolMethodAsync("Emulation.setEmulatedMedia",
            "{\"features\":[{\"name\":\"prefers-reduced-motion\",\"value\":\"reduce\"}]}");
        browser.Reload();
        await Expect(browser, "matchMedia('(prefers-reduced-motion: reduce)').matches &&" +
            " !document.getElementById('startup').open && !document.getElementById('startup-typed').children.length &&" +
            " !document.getElementById('import-start').hidden && document.getElementById('analysis').hidden");

        await browser.ExecuteScriptAsync("(function(){const transfer=new DataTransfer();" +
            "transfer.items.add(new File(['not a workbook'],'invalid.xlsx'));const input=document.getElementById('upload');" +
            "input.files=transfer.files;input.dispatchEvent(new Event('change'));})()");
        await Expect(browser, "!document.getElementById('error').hidden && document.getElementById('analysis').hidden");

        string payload;
        using (var input = new FileStream(verification[0], FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        using (var bytes = new MemoryStream())
        {
            input.CopyTo(bytes);
            payload = Convert.ToBase64String(bytes.ToArray());
        }
        await browser.ExecuteScriptAsync("(function(){const transfer=new DataTransfer();" +
            "const bytes=Uint8Array.from(atob('" + payload + "'), x=>x.charCodeAt(0));" +
            "transfer.items.add(new File([bytes],'case.xlsx'));const input=document.getElementById('upload');" +
            "input.files=transfer.files;input.dispatchEvent(new Event('change'));})()");
        await Expect(browser, "!document.getElementById('analysis').hidden && document.getElementById('import-start').hidden && document.getElementById('error').hidden && document.getElementById('source').textContent === 'case.xlsx' && document.querySelectorAll('#rows tr').length === 25");
        using (var shot = File.Create(Path.ChangeExtension(verification[1], ".analysis.png")))
            await browser.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, shot);

        await Expect(browser, "(() => {" +
            "const rows=document.getElementById('rows'), first=rows.firstElementChild, row=rows.children[10];" +
            "const button=row.querySelector('button'), scroller=rows.closest('.queue-scroll');" +
            "scroller.scrollTop=150; const scroll=scroller.scrollTop;" +
            "button.focus({preventScroll:true}); button.click();" +
            "return first===rows.firstElementChild && !first.classList.contains('selected') && row.classList.contains('selected') &&" +
            " document.activeElement===button && button.getAttribute('aria-current')==='true' &&" +
            " scroller.scrollTop===scroll && document.querySelector('#detail .eyebrow').textContent.startsWith(row.dataset.id);" +
            "})()");

        await browser.ExecuteScriptAsync("document.getElementById('open-letter').click();" +
            "document.getElementById('letter-sender').value='Картон-Сервис';" +
            "document.getElementById('letter-body').value='Счёт 98 по ЗП-14: прокладка 1200×800, 500 шт. по 12 руб. Итого 6 000 руб.';" +
            "document.getElementById('letter-form').requestSubmit()");
        await Expect(browser, "document.querySelectorAll('#rows tr').length === 26 && document.querySelector('#detail .badge').textContent === 'Сверен'");

        await Expect(browser, "!document.getElementById('download-results').disabled");
        var downloaded = new TaskCompletionSource<string>();
        string exportPath = Path.ChangeExtension(verification[1], ".results.xlsx");
        EventHandler<CoreWebView2DownloadStartingEventArgs> save = (sender, args) =>
        {
            args.ResultFilePath = exportPath;
            args.Handled = true;
            var operation = args.DownloadOperation;
            operation.StateChanged += (source, evt) =>
            {
                if (operation.State != CoreWebView2DownloadState.InProgress)
                    downloaded.TrySetResult(operation.State == CoreWebView2DownloadState.Completed
                        ? "Completed" : operation.InterruptReason.ToString());
            };
        };
        browser.DownloadStarting += save;
        await browser.ExecuteScriptAsync("document.querySelector('#filters [data-filter=ready]').click(); document.getElementById('download-results').click()");
        await Task.WhenAny(downloaded.Task, Task.Delay(10000));
        browser.DownloadStarting -= save;
        if (!downloaded.Task.IsCompleted || downloaded.Task.Result != "Completed" || !File.Exists(exportPath))
            throw new InvalidOperationException("Excel export did not finish: " +
                (downloaded.Task.IsCompleted ? downloaded.Task.Result : "timed out") + " | " +
                await browser.ExecuteScriptAsync("document.getElementById('error').textContent"));
    }

    private static async Task Expect(CoreWebView2 browser, string expression)
    {
        for (int i = 0; i < 45; i++)
        {
            if (await browser.ExecuteScriptAsync("Boolean(" + expression + ")") == "true") return;
            await Task.Delay(200);
        }
        string error = await browser.ExecuteScriptAsync("document.getElementById('error') && document.getElementById('error').textContent");
        throw new InvalidOperationException(expression + " | " + error);
    }
#endif
}
