$code = @'
using System;
using System.Runtime.InteropServices;

public static class Aud {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        int Activate(ref Guid iid, int clsCtx, IntPtr act, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int access, out IPropertyStore store);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        int GetCount(out int count);
        int GetAt(int i, out PROPERTYKEY key);
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT val);
        int SetValue(ref PROPERTYKEY key, ref PROPVARIANT val);
        int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY { public Guid fmtid; public int pid; }

    [StructLayout(LayoutKind.Explicit)]
    struct PROPVARIANT {
        [FieldOffset(0)] public short vt;
        [FieldOffset(8)] public IntPtr p;
    }

    static string Name(IMMDevice dev) {
        IPropertyStore store;
        dev.OpenPropertyStore(0, out store);
        var key = new PROPERTYKEY();
        key.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
        key.pid = 14; // PKEY_Device_FriendlyName
        PROPVARIANT v;
        store.GetValue(ref key, out v);
        return Marshal.PtrToStringUni(v.p);
    }

    // dataFlow: 0 = render (salida), 1 = capture. role: 0 = console, 1 = multimedia, 2 = communications
    public static string Get(int flow, int role) {
        var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice dev;
        int hr = en.GetDefaultAudioEndpoint(flow, role, out dev);
        if (hr != 0) return "(ninguno)";
        return Name(dev);
    }
}
'@
Add-Type -TypeDefinition $code -Language CSharp

$out = [ordered]@{
  renderConsole    = [Aud]::Get(0,0)
  renderMultimedia = [Aud]::Get(0,1)
  renderComms      = [Aud]::Get(0,2)
  captureConsole   = [Aud]::Get(1,0)
}
$out | ConvertTo-Json -Compress
