using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

sealed class RustSession : IDisposable
{
    private readonly Process process;
    private readonly StreamWriter input;
    private readonly SemaphoreSlim requests = new SemaphoreSlim(1);
    private bool disposed;

    internal RustSession(string executable)
    {
        process = new Process
        {
            StartInfo = new ProcessStartInfo(executable)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                StandardOutputEncoding = Encoding.UTF8,
            }
        };
        if (!process.Start()) throw new IOException("Не удалось запустить модуль сверки.");
        input = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false));
    }

    internal async Task<string> SendAsync(string request)
    {
        await requests.WaitAsync();
        try
        {
            if (disposed || process.HasExited) throw new IOException("Модуль сверки завершился.");
            await input.WriteLineAsync(request);
            await input.FlushAsync();
            string response = await process.StandardOutput.ReadLineAsync();
            if (response == null) throw new IOException("Модуль сверки завершился без ответа.");
            return response;
        }
        finally
        {
            requests.Release();
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        try
        {
            if (!process.HasExited)
            {
                process.Kill();
                process.WaitForExit(1500);
            }
        }
        finally
        {
            input.Dispose();
            process.Dispose();
        }
    }
}
