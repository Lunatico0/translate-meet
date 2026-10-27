$code = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class AudList {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection {
        int GetCount(out int count);
        int Item(int i, out IMMDevice dev);
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
    struct PROPVARIANT { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }

    static string Name(IMMDevice dev) {
        IPropertyStore store;
        dev.OpenPropertyStore(0, out store);
        var key = new PROPERTYKEY();
        key.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
        key.pid = 14;
        PROPVARIANT v;
        store.GetValue(ref key, out v);
        return Marshal.PtrToStringUni(v.p);
    }

    static string StateName(int s) {
        if (s == 1) return "ACTIVO";
        if (s == 2) return "DESHABILITADO";
        if (s == 4) return "NO PRESENTE";
        if (s == 8) return "DESCONECTADO";
        return "?" + s;
    }

    // flow: 0 render, 1 capture. stateMask 15 = todos los estados
    public static List<string> All(int flow) {
        var res = new List<string>();
        var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDeviceCollection col;
        en.EnumAudioEndpoints(flow, 15, out col);
        int n; col.GetCount(out n);
        for (int i = 0; i < n; i++) {
            IMMDevice d; col.Item(i, out d);
            int st; d.GetState(out st);
            res.Add(StateName(st) + " | " + Name(d));
        }
        return res;
    }
}
'@
Add-Type -TypeDefinition $code -Language CSharp

$caps = @()
foreach ($e in [AudList]::All(1)) {
  $parts = $e -split ' \| ', 2
  if ($parts[0] -ne 'NO PRESENTE') {
    $caps += [ordered]@{ state = $parts[0]; name = $parts[1] }
  }
}
$caps | ConvertTo-Json -Compress
