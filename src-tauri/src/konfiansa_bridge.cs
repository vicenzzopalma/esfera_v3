// Ponte do Esfera com o Konfiansa (serviço WCF do próprio Konfiansa, via DLLs do app instalado).
// O Esfera compila este arquivo com o csc do .NET Framework na primeira vez que precisa dele.
//
// Uso: KonfiansaBridge.exe --check
//      KonfiansaBridge.exe --query-file <arquivo.sql>     (SQL em UTF-8; saída JSON em UTF-8)
//
// Servidor e serviço: registro HKCU\Software\Konfiansa (ServidorLocal, Servidor).
// Pasta do app: a versão mais nova em %LOCALAPPDATA%\Apps\2.0 com Recovery.DatabaseClient.dll.
// Credenciais: variáveis KONFIANSA_WIN_USER, KONFIANSA_WIN_PASS e KONFIANSA_LOGON (o Esfera
// passa as da configuração local; nunca ficam no código).
using System;
using System.Data;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Reflection;
using System.ServiceModel;
using System.Text;
using Microsoft.Win32;

namespace EsferaKonfiansa
{
    class Program
    {
        static string _appDir;

        static int Main(string[] args)
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            try
            {
                _appDir = FindAppDir();
                AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
                {
                    string name = new AssemblyName(e.Name).Name;
                    foreach (var ext in new[] { ".dll", ".exe" })
                    {
                        string p = Path.Combine(_appDir, name + ext);
                        if (File.Exists(p)) return Assembly.LoadFrom(p);
                    }
                    return null;
                };
                if (args.Length >= 1 && args[0] == "--check") { Check(); return 0; }
                if (args.Length >= 2 && args[0] == "--query-file")
                {
                    Query(File.ReadAllText(args[1], Encoding.UTF8));
                    return 0;
                }
                Console.Error.WriteLine("Uso: --check | --query-file <arquivo.sql>");
                return 1;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("ERRO: " + ex.Message + (ex.InnerException != null ? " | " + ex.InnerException.Message : ""));
                return 2;
            }
        }

        static string FindAppDir()
        {
            string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Apps", "2.0");
            var dir = Directory.GetFiles(root, "Recovery.DatabaseClient.dll", SearchOption.AllDirectories)
                .Select(f => new FileInfo(f))
                .Where(f => File.Exists(Path.Combine(f.DirectoryName, "Recovery.Shared.dll")))
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .Select(f => f.DirectoryName)
                .FirstOrDefault();
            if (dir == null) throw new Exception("Konfiansa não está instalado neste computador (Recovery.DatabaseClient.dll não encontrado).");
            return dir;
        }

        static string Reg(string name)
        {
            using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Konfiansa"))
            {
                object v = k == null ? null : k.GetValue(name);
                return v == null ? "" : v.ToString().Trim();
            }
        }

        static string Env(string name)
        {
            string v = Environment.GetEnvironmentVariable(name);
            if (string.IsNullOrWhiteSpace(v)) throw new Exception("Credencial do Konfiansa ausente: " + name);
            return v;
        }

        static dynamic Client()
        {
            string server = Reg("ServidorLocal");
            string service = Reg("Servidor");
            if (server == "" || service == "") throw new Exception("Servidor do Konfiansa não configurado no registro (HKCU\\Software\\Konfiansa).");
            string user = Env("KONFIANSA_WIN_USER"), pass = Env("KONFIANSA_WIN_PASS"), logon = Env("KONFIANSA_LOGON");

            Assembly shared = Assembly.LoadFrom(Path.Combine(_appDir, "Recovery.Shared.dll"));
            Assembly dbAsm = Assembly.LoadFrom(Path.Combine(_appDir, "Recovery.DatabaseClient.dll"));
            Type st = shared.GetType("Recovery.Shared.ClsShared");
            st.GetProperty("vProtocoloConexao").SetValue(null, Enum.Parse(shared.GetType("Recovery.Shared.EnumProtocoloConexao"), "NetTcpBinding"), null);
            st.GetProperty("vLocalConexao").SetValue(null, Enum.Parse(shared.GetType("Recovery.Shared.EnumTipoLocalConexao"), "jLocalInterno"), null);
            st.GetProperty("vEnderecoServico").SetValue(null, string.Format("net.tcp://{0}/{1}/", server, service), null);
            st.GetProperty("vConexaoCredentialWindows").SetValue(null, new NetworkCredential(user, pass), null);
            st.GetProperty("UsuarioLogon").SetValue(null, logon, null);

            var binding = new NetTcpBinding(SecurityMode.Transport);
            binding.Security.Transport.ClientCredentialType = TcpClientCredentialType.Windows;
            binding.Security.Transport.ProtectionLevel = ProtectionLevel.EncryptAndSign;
            binding.MaxReceivedMessageSize = int.MaxValue;
            binding.MaxBufferSize = int.MaxValue;
            binding.ReaderQuotas.MaxStringContentLength = int.MaxValue;
            binding.ReaderQuotas.MaxArrayLength = int.MaxValue;
            binding.OpenTimeout = TimeSpan.FromSeconds(30);
            binding.SendTimeout = TimeSpan.FromMinutes(2);
            binding.ReceiveTimeout = TimeSpan.FromMinutes(2);
            var address = new EndpointAddress(string.Format("net.tcp://{0}/{1}/Recovery.BLL.Database.svc", server, service));
            dynamic client = Activator.CreateInstance(dbAsm.GetType("Recovery.DatabaseClient.BLL.Database.ClsDatabaseClient"), binding, address);
            client.ClientCredentials.Windows.ClientCredential = new NetworkCredential(user, pass);
            client.AutenticaServico(logon);
            return client;
        }

        static void Check()
        {
            dynamic c = Client();
            try { DateTime dt = c.DataServ(); Console.WriteLine("{\"ok\":true,\"serverTime\":\"" + dt.ToString("yyyy-MM-dd HH:mm:ss") + "\"}"); }
            finally { try { c.Close(); } catch { c.Abort(); } }
        }

        static void Query(string sql)
        {
            dynamic c = Client();
            try
            {
                DataTable dt = c.CarregaDataTable("sp_sqlexec '" + sql.Replace("'", "''") + "'");
                var sb = new StringBuilder("[");
                if (dt != null)
                {
                    for (int r = 0; r < dt.Rows.Count; r++)
                    {
                        if (r > 0) sb.Append(',');
                        sb.Append('{');
                        for (int i = 0; i < dt.Columns.Count; i++)
                        {
                            if (i > 0) sb.Append(',');
                            sb.Append('"').Append(Esc(dt.Columns[i].ColumnName)).Append("\":");
                            object v = dt.Rows[r][i];
                            if (v == null || v == DBNull.Value) sb.Append("null");
                            else if (v is bool) sb.Append((bool)v ? "true" : "false");
                            else if (v is int || v is long || v is short || v is byte || v is decimal || v is double || v is float)
                                sb.Append(Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture));
                            else if (v is DateTime) sb.Append('"').Append(((DateTime)v).ToString("yyyy-MM-dd HH:mm:ss")).Append('"');
                            else sb.Append('"').Append(Esc(v.ToString())).Append('"');
                        }
                        sb.Append('}');
                    }
                }
                sb.Append(']');
                Console.WriteLine(sb.ToString());
            }
            finally { try { c.Close(); } catch { c.Abort(); } }
        }

        static string Esc(string s)
        {
            var sb = new StringBuilder(s.Length + 8);
            foreach (char ch in s)
            {
                switch (ch)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (ch < ' ') sb.AppendFormat("\\u{0:x4}", (int)ch); else sb.Append(ch);
                        break;
                }
            }
            return sb.ToString();
        }
    }
}
