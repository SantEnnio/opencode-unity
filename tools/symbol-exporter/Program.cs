// Dumps the public API surface of .NET assemblies as JSON Lines (one type per line).
// Used to build the Unity symbol graph from the DLLs of the installed Editor, so the
// signatures and [Obsolete] messages always match the exact Unity version in use.
//
// usage: symbol-exporter --out <file.jsonl> --dir <dir> [--dir <dir> ...] [--file <dll> ...] [--exclude <regex>]

using System.Text;
using System.Text.RegularExpressions;
using System.Text.Json;
using System.Xml;
using Mono.Cecil;
using Mono.Cecil.Rocks;

namespace OpencodeUnity.SymbolExporter;

internal static class Program
{
    private static int Main(string[] args)
    {
        var dirs = new List<string>();
        var files = new List<string>();
        string? outPath = null;
        Regex? exclude = null;

        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--out" when i + 1 < args.Length: outPath = args[++i]; break;
                case "--dir" when i + 1 < args.Length: dirs.Add(args[++i]); break;
                case "--file" when i + 1 < args.Length: files.Add(args[++i]); break;
                case "--exclude" when i + 1 < args.Length: exclude = new Regex(args[++i], RegexOptions.IgnoreCase); break;
                default:
                    Console.Error.WriteLine($"unknown argument: {args[i]}");
                    return 2;
            }
        }

        if (outPath is null || (dirs.Count == 0 && files.Count == 0))
        {
            Console.Error.WriteLine("usage: symbol-exporter --out <file.jsonl> --dir <dir> [--dir <dir> ...] [--file <dll> ...] [--exclude <regex>]");
            return 2;
        }

        foreach (var dir in dirs)
        {
            if (!Directory.Exists(dir))
            {
                Console.Error.WriteLine($"directory not found: {dir}");
                return 2;
            }
            files.AddRange(Directory.EnumerateFiles(dir, "*.dll", SearchOption.TopDirectoryOnly));
        }
        if (exclude is not null) files.RemoveAll(f => exclude.IsMatch(Path.GetFileName(f)));
        files.Sort(StringComparer.OrdinalIgnoreCase);

        var resolver = new DefaultAssemblyResolver();
        foreach (var dir in files.Select(Path.GetDirectoryName).Where(d => d is not null).Distinct())
            resolver.AddSearchDirectory(dir);

        var readerParams = new ReaderParameters { AssemblyResolver = resolver, ReadSymbols = false };
        int typeCount = 0, skipped = 0;

        using var stream = new FileStream(outPath, FileMode.Create, FileAccess.Write);
        foreach (var file in files)
        {
            AssemblyDefinition asm;
            try
            {
                asm = AssemblyDefinition.ReadAssembly(file, readerParams);
            }
            catch (BadImageFormatException)
            {
                skipped++; // native DLL
                continue;
            }

            using (asm)
            {
                var docs = XmlDocs.Load(Path.ChangeExtension(file, ".xml"));
                foreach (var type in asm.MainModule.GetAllTypes())
                {
                    if (!Api.IsVisible(type)) continue;
                    using var writer = new Utf8JsonWriter(stream);
                    TypeWriter.Write(writer, asm.Name.Name, type, docs);
                    writer.Flush();
                    stream.WriteByte((byte)'\n');
                    typeCount++;
                }
            }
        }

        Console.Error.WriteLine($"exported {typeCount} types from {files.Count - skipped} assemblies");
        return 0;
    }
}

internal static class TypeWriter
{
    public static void Write(Utf8JsonWriter w, string asmName, TypeDefinition type, XmlDocs docs)
    {
        w.WriteStartObject();
        w.WriteString("asm", asmName);
        w.WriteString("ns", Names.Namespace(type));
        w.WriteString("name", Names.Display(type, qualified: false));
        w.WriteString("simple", Names.StripArity(type.Name));
        w.WriteString("full", Names.Display(type, qualified: true));
        w.WriteString("kind", Api.Kind(type));
        if (type.IsAbstract && type.IsSealed) w.WriteBoolean("static", true);

        if (type.BaseType is { } baseType && !Api.IsImplicitBase(baseType))
            w.WriteString("base", Names.Format(baseType, qualified: true));

        if (type.HasInterfaces)
        {
            w.WriteStartArray("interfaces");
            foreach (var iface in type.Interfaces)
                w.WriteStringValue(Names.Format(iface.InterfaceType, qualified: true));
            w.WriteEndArray();
        }

        WriteObsolete(w, type);
        WriteSummary(w, docs, type);

        w.WriteStartArray("members");
        if (!Api.IsDelegate(type))
        {
            foreach (var field in type.Fields) WriteField(w, type, field, docs);
            foreach (var prop in type.Properties) WriteProperty(w, prop, docs);
            foreach (var evt in type.Events) WriteEvent(w, evt, docs);
            foreach (var method in type.Methods) WriteMethod(w, method, docs);
        }
        w.WriteEndArray();
        w.WriteEndObject();
    }

    private static void WriteField(Utf8JsonWriter w, TypeDefinition owner, FieldDefinition field, XmlDocs docs)
    {
        if (!(field.IsPublic || field.IsFamily || field.IsFamilyOrAssembly)) return;
        if (field.IsSpecialName || field.IsRuntimeSpecialName) return; // enum value__

        var sig = new StringBuilder();
        if (owner.IsEnum)
        {
            sig.Append(owner.Name).Append('.').Append(field.Name);
            if (field.HasConstant) sig.Append(" = ").Append(field.Constant);
        }
        else
        {
            sig.Append(field.IsPublic ? "public " : "protected ");
            if (field.IsLiteral) sig.Append("const ");
            else if (field.IsStatic) sig.Append("static ");
            if (field.IsInitOnly) sig.Append("readonly ");
            sig.Append(Names.Format(field.FieldType, qualified: false)).Append(' ').Append(field.Name);
        }

        w.WriteStartObject();
        w.WriteString("name", field.Name);
        w.WriteString("kind", owner.IsEnum ? "enumvalue" : "field");
        w.WriteString("sig", sig.ToString());
        if (field.IsStatic) w.WriteBoolean("static", true);
        w.WriteString("type", Names.Format(field.FieldType, qualified: true));
        WriteObsolete(w, field);
        WriteSummary(w, docs, field);
        w.WriteEndObject();
    }

    private static void WriteProperty(Utf8JsonWriter w, PropertyDefinition prop, XmlDocs docs)
    {
        var getter = Api.IsVisible(prop.GetMethod) ? prop.GetMethod : null;
        var setter = Api.IsVisible(prop.SetMethod) ? prop.SetMethod : null;
        var accessor = getter ?? setter;
        if (accessor is null) return;

        var sig = new StringBuilder();
        sig.Append(Api.Modifiers(accessor));
        sig.Append(Names.Format(prop.PropertyType, qualified: false)).Append(' ');
        if (prop.HasParameters)
            sig.Append("this[").Append(Names.Parameters(prop.Parameters)).Append(']');
        else
            sig.Append(prop.Name);
        sig.Append(" { ");
        if (getter is not null) sig.Append("get; ");
        if (setter is not null) sig.Append("set; ");
        sig.Append('}');

        w.WriteStartObject();
        w.WriteString("name", prop.Name);
        w.WriteString("kind", "property");
        w.WriteString("sig", sig.ToString());
        if (accessor.IsStatic) w.WriteBoolean("static", true);
        w.WriteString("type", Names.Format(prop.PropertyType, qualified: true));
        if (setter is null) w.WriteBoolean("readonly", true);
        WriteObsolete(w, prop);
        WriteSummary(w, docs, prop);
        w.WriteEndObject();
    }

    private static void WriteEvent(Utf8JsonWriter w, EventDefinition evt, XmlDocs docs)
    {
        var accessor = evt.AddMethod ?? evt.RemoveMethod;
        if (!Api.IsVisible(accessor)) return;

        w.WriteStartObject();
        w.WriteString("name", evt.Name);
        w.WriteString("kind", "event");
        w.WriteString("sig", $"{Api.Modifiers(accessor!)}event {Names.Format(evt.EventType, qualified: false)} {evt.Name}");
        if (accessor!.IsStatic) w.WriteBoolean("static", true);
        w.WriteString("type", Names.Format(evt.EventType, qualified: true));
        WriteObsolete(w, evt);
        WriteSummary(w, docs, evt);
        w.WriteEndObject();
    }

    private static void WriteMethod(Utf8JsonWriter w, MethodDefinition method, XmlDocs docs)
    {
        if (!Api.IsVisible(method)) return;
        if (method.IsGetter || method.IsSetter || method.IsAddOn || method.IsRemoveOn) return;
        if (method.IsConstructor && method.IsStatic) return;
        if (method.IsSpecialName && !method.IsConstructor) return; // operators
        if (method.Name == "Finalize") return;

        var isExtension = method.IsStatic && method.HasParameters && Api.HasAttribute(method, "System.Runtime.CompilerServices.ExtensionAttribute");
        var name = method.IsConstructor ? Names.StripArity(method.DeclaringType.Name) : method.Name;

        var sig = new StringBuilder();
        sig.Append(Api.Modifiers(method));
        if (!method.IsConstructor) sig.Append(Names.Format(method.ReturnType, qualified: false)).Append(' ');
        sig.Append(name);
        if (method.HasGenericParameters)
            sig.Append('<').Append(string.Join(", ", method.GenericParameters.Select(p => p.Name))).Append('>');
        sig.Append('(');
        if (isExtension) sig.Append("this ");
        sig.Append(Names.Parameters(method.Parameters));
        sig.Append(')');

        w.WriteStartObject();
        w.WriteString("name", name);
        w.WriteString("kind", method.IsConstructor ? "ctor" : "method");
        w.WriteString("sig", sig.ToString());
        if (method.IsStatic) w.WriteBoolean("static", true);
        if (!method.IsConstructor) w.WriteString("type", Names.Format(method.ReturnType, qualified: true));
        if (isExtension) w.WriteString("extends", Names.Format(method.Parameters[0].ParameterType, qualified: true));
        WriteObsolete(w, method);
        WriteSummary(w, docs, method);
        w.WriteEndObject();
    }

    private static void WriteObsolete(Utf8JsonWriter w, ICustomAttributeProvider provider)
    {
        if (!provider.HasCustomAttributes) return;
        foreach (var attr in provider.CustomAttributes)
        {
            if (attr.AttributeType.FullName != "System.ObsoleteAttribute") continue;
            var message = "";
            var isError = false;
            try
            {
                var ctorArgs = attr.ConstructorArguments;
                if (ctorArgs.Count > 0 && ctorArgs[0].Value is string s) message = s;
                if (ctorArgs.Count > 1 && ctorArgs[1].Value is bool b) isError = b;
            }
            catch (AssemblyResolutionException)
            {
                // attribute blob could not be decoded: still flag the member as obsolete
            }

            w.WriteStartObject("obsolete");
            w.WriteString("message", message);
            w.WriteBoolean("error", isError);
            w.WriteEndObject();
            return;
        }
    }

    private static void WriteSummary(Utf8JsonWriter w, XmlDocs docs, IMemberDefinition member)
    {
        var summary = docs.Summary(member);
        if (summary is not null) w.WriteString("summary", summary);
    }
}

internal static class Api
{
    public static bool IsVisible(TypeDefinition type)
    {
        if (type.Name.StartsWith('<')) return false;
        for (var t = type; t is not null; t = t.DeclaringType)
        {
            var visible = t.IsNested ? t.IsNestedPublic || t.IsNestedFamily || t.IsNestedFamilyOrAssembly : t.IsPublic;
            if (!visible) return false;
        }
        return true;
    }

    public static bool IsVisible(MethodDefinition? method) =>
        method is not null && (method.IsPublic || method.IsFamily || method.IsFamilyOrAssembly);

    public static bool IsDelegate(TypeDefinition type) => type.BaseType?.FullName == "System.MulticastDelegate";

    public static bool IsImplicitBase(TypeReference baseType) => baseType.FullName
        is "System.Object" or "System.ValueType" or "System.Enum" or "System.MulticastDelegate";

    public static string Kind(TypeDefinition type)
    {
        if (type.IsEnum) return "enum";
        if (type.IsInterface) return "interface";
        if (IsDelegate(type)) return "delegate";
        if (type.IsValueType) return "struct";
        return "class";
    }

    public static string Modifiers(MethodDefinition method)
    {
        var sb = new StringBuilder();
        if (!method.DeclaringType.IsInterface) sb.Append(method.IsPublic ? "public " : "protected ");
        if (method.IsStatic) sb.Append("static ");
        else if (method.IsAbstract && !method.DeclaringType.IsInterface) sb.Append("abstract ");
        else if (method.IsVirtual && !method.IsFinal && !method.DeclaringType.IsInterface)
            sb.Append(method.IsNewSlot ? "virtual " : "override ");
        return sb.ToString();
    }

    public static bool HasAttribute(ICustomAttributeProvider provider, string fullName) =>
        provider.HasCustomAttributes && provider.CustomAttributes.Any(a => a.AttributeType.FullName == fullName);
}

internal static class Names
{
    private static readonly Dictionary<string, string> Keywords = new()
    {
        ["System.Void"] = "void", ["System.Boolean"] = "bool", ["System.Byte"] = "byte", ["System.SByte"] = "sbyte",
        ["System.Char"] = "char", ["System.Int16"] = "short", ["System.UInt16"] = "ushort", ["System.Int32"] = "int",
        ["System.UInt32"] = "uint", ["System.Int64"] = "long", ["System.UInt64"] = "ulong", ["System.Single"] = "float",
        ["System.Double"] = "double", ["System.Decimal"] = "decimal", ["System.String"] = "string", ["System.Object"] = "object",
    };

    public static string StripArity(string name)
    {
        var tick = name.IndexOf('`');
        return tick < 0 ? name : name[..tick];
    }

    public static string Namespace(TypeReference type)
    {
        while (type.DeclaringType is not null) type = type.DeclaringType;
        return type.Namespace ?? "";
    }

    /// <summary>Display name of a type definition, e.g. "UnityEngine.Events.UnityEvent&lt;T0&gt;".</summary>
    public static string Display(TypeDefinition type, bool qualified)
    {
        var name = Path(type, qualified);
        if (!type.HasGenericParameters) return name;
        return $"{name}<{string.Join(", ", type.GenericParameters.Select(p => p.Name))}>";
    }

    public static string Format(TypeReference type, bool qualified)
    {
        switch (type)
        {
            case ByReferenceType byRef:
                return Format(byRef.ElementType, qualified);
            case ArrayType array:
                return Format(array.ElementType, qualified) + "[" + new string(',', array.Rank - 1) + "]";
            case PointerType pointer:
                return Format(pointer.ElementType, qualified) + "*";
            case RequiredModifierType reqMod:
                return Format(reqMod.ElementType, qualified);
            case OptionalModifierType optMod:
                return Format(optMod.ElementType, qualified);
            case GenericParameter genericParam:
                return genericParam.Name;
            case GenericInstanceType generic:
                if (generic.ElementType.FullName == "System.Nullable`1" && generic.GenericArguments.Count == 1)
                    return Format(generic.GenericArguments[0], qualified) + "?";
                return Path(generic.ElementType, qualified) + "<" +
                       string.Join(", ", generic.GenericArguments.Select(a => Format(a, qualified))) + ">";
        }

        return Keywords.TryGetValue(type.FullName, out var keyword) ? keyword : Path(type, qualified);
    }

    public static string Parameters(IEnumerable<ParameterDefinition> parameters) =>
        string.Join(", ", parameters.Select(Parameter));

    private static string Parameter(ParameterDefinition p)
    {
        var sb = new StringBuilder();
        if (p.ParameterType is ByReferenceType) sb.Append(p.IsOut ? "out " : p.IsIn ? "in " : "ref ");
        if (Api.HasAttribute(p, "System.ParamArrayAttribute")) sb.Append("params ");
        sb.Append(Format(p.ParameterType, qualified: false)).Append(' ').Append(p.Name);
        if (p.HasConstant) sb.Append(" = ").Append(Constant(p));
        else if (p.IsOptional) sb.Append(" = default");
        return sb.ToString();
    }

    private static string Constant(ParameterDefinition p)
    {
        switch (p.Constant)
        {
            case null: return p.ParameterType.IsValueType ? "default" : "null";
            case string s: return "\"" + s + "\"";
            case bool b: return b ? "true" : "false";
            case float f: return f.ToString("R", System.Globalization.CultureInfo.InvariantCulture) + "f";
            case double d: return d.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        }

        // Enum defaults are stored as their underlying integer: map them back to the enum member name.
        try
        {
            if (p.ParameterType.Resolve() is { IsEnum: true } enumType)
            {
                var value = Convert.ToInt64(p.Constant);
                var match = enumType.Fields.FirstOrDefault(f => f.HasConstant && Convert.ToInt64(f.Constant) == value);
                if (match is not null) return StripArity(enumType.Name) + "." + match.Name;
            }
        }
        catch (Exception e) when (e is AssemblyResolutionException or OverflowException or InvalidCastException)
        {
            // fall through to the raw value
        }

        return Convert.ToString(p.Constant, System.Globalization.CultureInfo.InvariantCulture) ?? "default";
    }

    private static string Path(TypeReference type, bool qualified)
    {
        var parts = new List<string>();
        for (var t = type; t is not null; t = t.DeclaringType) parts.Add(StripArity(t.Name));
        parts.Reverse();
        var name = string.Join(".", parts);
        if (!qualified) return name;
        var ns = Namespace(type);
        return ns.Length == 0 ? name : ns + "." + name;
    }
}

/// <summary>Summaries from the XML documentation file that ships next to each Unity DLL.</summary>
internal sealed class XmlDocs
{
    private readonly Dictionary<string, string> _summaries = new(StringComparer.Ordinal);

    public static XmlDocs Load(string path)
    {
        var docs = new XmlDocs();
        if (!File.Exists(path)) return docs;

        try
        {
            using var reader = XmlReader.Create(path, new XmlReaderSettings { DtdProcessing = DtdProcessing.Ignore });
            string? current = null;
            while (reader.Read())
            {
                if (reader.NodeType != XmlNodeType.Element) continue;
                if (reader.Name == "member")
                {
                    current = reader.GetAttribute("name");
                }
                else if (reader.Name == "summary" && current is not null)
                {
                    var text = Normalize(reader.ReadInnerXml());
                    if (text.Length > 0) docs._summaries[current] = text;
                }
            }
        }
        catch (XmlException e)
        {
            Console.Error.WriteLine($"warning: could not parse {path}: {e.Message}");
        }

        return docs;
    }

    public string? Summary(IMemberDefinition member)
    {
        if (_summaries.Count == 0) return null;
        string id;
        try
        {
            id = DocCommentId.GetDocCommentId(member);
        }
        catch (Exception e) when (e is NotSupportedException or ArgumentException)
        {
            return null;
        }
        return _summaries.TryGetValue(id, out var summary) ? summary : null;
    }

    private static string Normalize(string innerXml)
    {
        var sb = new StringBuilder(innerXml.Length);
        var inTag = false;
        foreach (var c in innerXml)
        {
            if (c == '<') inTag = true;
            else if (c == '>') { inTag = false; sb.Append(' '); }
            else if (!inTag) sb.Append(c);
        }
        var text = System.Net.WebUtility.HtmlDecode(sb.ToString());
        return string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
    }
}
