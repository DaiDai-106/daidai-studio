#include <BRepMesh_IncrementalMesh.hxx>
#include <BRep_Tool.hxx>
#include <DESTEP_Parameters.hxx>
#include <Poly_Triangulation.hxx>
#include <Quantity_ColorRGBA.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <STEPConstruct_ExternRefs.hxx>
#include <Standard_Failure.hxx>
#include <StlAPI_Writer.hxx>
#include <TColStd_SequenceOfAsciiString.hxx>
#include <TDataStd_Name.hxx>
#include <TDF_LabelIndexedMap.hxx>
#include <TDF_LabelMap.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDF_Tool.hxx>
#include <TDocStd_Document.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <gp_Quaternion.hxx>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

namespace {

namespace fs = std::filesystem;
using Json = nlohmann::json;
using Color = std::array<double, 4>;

constexpr auto maxInputBytes = 128 * 1024 * 1024;
constexpr auto maxMeshBytes = 8 * 1024 * 1024;
constexpr auto maxTotalMeshBytes = 48 * 1024 * 1024;
constexpr auto maxOccurrences = 511;
constexpr auto maxDepth = 48;
constexpr std::size_t stlHeaderBytes = 84;
constexpr std::size_t stlTriangleBytes = 50;

std::string entry(const TDF_Label& label) {
    TCollection_AsciiString value;
    TDF_Tool::Entry(label, value);
    return value.ToCString();
}

std::string name(const TDF_Label& label) {
    Handle(TDataStd_Name) attribute;
    if (!label.FindAttribute(TDataStd_Name::GetID(), attribute)) return {};
    const auto& value = attribute->Get();
    std::string utf8(value.LengthOfCString() + 1, '\0');
    char* bytes = utf8.data();
    utf8.resize(value.ToUTF8CString(bytes));
    const auto first = utf8.find_first_not_of(" \t\r\n\f\v");
    if (first == std::string::npos) return {};
    utf8 = utf8.substr(first, utf8.find_last_not_of(" \t\r\n\f\v") - first + 1);
    // Limit by Unicode character so long names cannot end in a partial UTF-8 sequence.
    int characters = 0;
    for (std::size_t index = 0; index < utf8.size(); ++index) {
        if ((static_cast<unsigned char>(utf8[index]) & 0xc0) != 0x80 && ++characters > 200) {
            utf8.resize(index);
            break;
        }
    }
    return utf8;
}

bool generatedName(const std::string& value) {
    return value.empty() || value.rfind("=>[", 0) == 0 ||
           (value.rfind("NAUO", 0) == 0 && value.size() > 4 &&
            value.find_first_not_of("0123456789", 4) == std::string::npos);
}

std::optional<Color> color(const TDF_Label& label) {
    Quantity_ColorRGBA value;
    for (const auto kind : {XCAFDoc_ColorSurf, XCAFDoc_ColorGen}) {
        if (XCAFDoc_ColorTool::GetColor(label, kind, value)) {
            const auto& rgb = value.GetRGB();
            return Color{rgb.Red(), rgb.Green(), rgb.Blue(), value.Alpha()};
        }
    }
    return std::nullopt;
}

Json origin(const TDF_Label& label) {
    const auto transform = XCAFDoc_ShapeTool::GetLocation(label).Transformation();
    const auto scale = transform.ScaleFactor();
    if (transform.IsNegative() || !std::isfinite(scale) || std::abs(scale - 1.0) > 1e-9) {
        throw std::runtime_error("STEP 包含带缩放或镜像的实例，请先在 CAD 中应用变换。");
    }
    const auto translation = transform.TranslationPart();
    std::array<double, 3> xyz{translation.X() * 0.001, translation.Y() * 0.001,
                              translation.Z() * 0.001};
    std::array<double, 3> rpy{};
    transform.GetRotation().GetEulerAngles(gp_Extrinsic_XYZ, rpy[0], rpy[1], rpy[2]);
    for (auto* vector : {&xyz, &rpy}) {
        for (auto& value : *vector) {
            if (!std::isfinite(value)) throw std::runtime_error("STEP 包含无效的实例变换。");
            if (value == 0.0) value = 0.0;
        }
    }
    return {{"xyz", xyz}, {"rpy", rpy}};
}

struct Assembly {
    Json occurrences = Json::array();
    TDF_LabelIndexedMap meshes;
    TDF_LabelMap ancestors;

    void visit(const TDF_Label& label, const std::string& parentId = {},
               std::optional<Color> rgba = std::nullopt);
};

std::string meshName(std::size_t index) {
    return "mesh-" + std::to_string(index) + ".stl";
}

void Assembly::visit(const TDF_Label& label, const std::string& parentId,
                     std::optional<Color> rgba) {
    if (occurrences.size() >= maxOccurrences || ancestors.Extent() >= maxDepth) {
        throw std::runtime_error("STEP 装配零件数量或嵌套深度超过限制。");
    }
    auto definition = label;
    TDF_LabelMap references;
    while (XCAFDoc_ShapeTool::IsReference(definition)) {
        if (!references.Add(definition)) {
            throw std::runtime_error("STEP 包含循环引用。");
        }
        TDF_Label referred;
        if (!XCAFDoc_ShapeTool::GetReferredShape(definition, referred)) {
            throw std::runtime_error("STEP 包含无效的装配引用。");
        }
        definition = referred;
    }
    if (!ancestors.Add(definition)) throw std::runtime_error("STEP 包含循环装配。");

    auto partName = name(label);
    if (generatedName(partName)) partName = name(definition);
    if (generatedName(partName)) partName = "零件 " + std::to_string(occurrences.size() + 1);
    const auto id = "part-" + std::to_string(occurrences.size());
    Json record{{"id", id}, {"parentId", parentId.empty() ? Json(nullptr) : Json(parentId)},
                {"name", partName}, {"origin", origin(label)}};
    if (const auto local = color(label)) {
        rgba = local;
    } else if (const auto fallback = color(definition)) {
        rgba = fallback;
    }

    const bool isAssembly = XCAFDoc_ShapeTool::IsAssembly(definition);
    if (!isAssembly) {
        record["mesh"] = meshName(meshes.Add(definition) - 1);
        if (rgba) record["color"] = *rgba;
    }
    occurrences.push_back(std::move(record));
    if (isAssembly) {
        TDF_LabelSequence children;
        XCAFDoc_ShapeTool::GetComponents(definition, children);
        if (children.IsEmpty()) throw std::runtime_error("STEP 包含空装配。");
        for (int index = 1; index <= children.Length(); ++index) {
            visit(children.Value(index), id, rgba);
        }
    }
    ancestors.Remove(definition);
}

struct MeshStats {
    std::size_t bytes = stlHeaderBytes;
    std::size_t skippedFaces = 0;
};

MeshStats meshStats(const TopoDS_Shape& shape) {
    const BRepMesh_IncrementalMesh mesher(shape, 0.1, false, 0.5, true);
    if (!mesher.IsDone()) throw std::runtime_error("STEP 零件网格化失败。");
    MeshStats stats;
    for (TopExp_Explorer face(shape, TopAbs_FACE); face.More(); face.Next()) {
        TopLoc_Location location;
        const auto& mesh = BRep_Tool::Triangulation(TopoDS::Face(face.Current()), location);
        if (mesh.IsNull() || mesh->NbTriangles() == 0) {
            ++stats.skippedFaces;
            continue;
        }
        stats.bytes += stlTriangleBytes * static_cast<std::size_t>(mesh->NbTriangles());
        if (stats.bytes > maxMeshBytes) throw std::runtime_error("单个 STEP 零件生成的网格超过 8 MiB。");
    }
    if (stats.bytes == stlHeaderBytes) throw std::runtime_error("STEP 零件没有可导出的三角面。");
    return stats;
}

void writeAssembly(const Assembly& assembly, const fs::path& destination) {
    if (!fs::create_directory(destination)) throw std::runtime_error("STEP 输出目录必须是新目录。");
    try {
        StlAPI_Writer writer;
        writer.ASCIIMode() = false;
        std::size_t total = 0;
        auto omissions = Json::array();
        for (int index = 1; index <= assembly.meshes.Extent(); ++index) {
            const auto& label = assembly.meshes.FindKey(index);
            auto shape = XCAFDoc_ShapeTool::GetShape(label);
            if (shape.IsNull()) throw std::runtime_error("STEP 零件没有有效几何。");
            shape.Location(TopLoc_Location());
            const auto stats = meshStats(shape);
            total += stats.bytes;
            if (total > maxTotalMeshBytes) {
                throw std::runtime_error("STEP 装配生成的网格总大小超过 48 MiB。");
            }
            if (stats.skippedFaces) {
                const auto part = name(label);
                omissions.push_back({{"part", part.empty() ? entry(label) : part},
                                     {"faces", stats.skippedFaces}});
            }
            const auto path = destination / meshName(index - 1);
            if (!writer.Write(shape, path.u8string().c_str()) || fs::file_size(path) != stats.bytes) {
                throw std::runtime_error("STEP 零件的 STL 输出不完整。");
            }
        }
        Json manifest{{"version", 1}, {"meshUnit", "mm"}, {"occurrences", assembly.occurrences}};
        if (!omissions.empty()) manifest["omissions"] = std::move(omissions);
        std::ofstream output(destination / "assembly.json", std::ios::binary);
        output.exceptions(std::ios::failbit | std::ios::badbit);
        output << manifest.dump(-1, ' ', false, Json::error_handler_t::replace);
        output.close();
    } catch (...) {
        std::error_code ignored;
        fs::remove_all(destination, ignored);
        throw;
    }
}

void importStep(const fs::path& source, const fs::path& destination, bool gbk) {
    auto suffix = source.extension().u8string();
    std::transform(suffix.begin(), suffix.end(), suffix.begin(),
                   [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
    if ((suffix != ".step" && suffix != ".stp") || !fs::is_regular_file(source)) {
        throw std::runtime_error("请选择 .step 或 .stp 文件。");
    }
    const auto size = fs::file_size(source);
    if (size == 0 || size > maxInputBytes) {
        throw std::runtime_error("STEP 文件为空或超过 128 MiB。");
    }

    STEPCAFControl_Reader reader;
    reader.SetNameMode(true);
    reader.SetColorMode(true);
    auto& step = reader.ChangeReader();
    DESTEP_Parameters parameters;
    parameters.InitFromStatic();
    if (gbk) parameters.ReadCodePage = Resource_FormatType_GBK;
    std::ifstream input(source, std::ios::binary);
    if (!input || step.ReadStream("source.step", parameters, input) != IFSelect_RetDone) {
        throw std::runtime_error("STEP 解析失败，请检查文件内容。");
    }
    TColStd_SequenceOfAsciiString lengths, angles, solidAngles;
    step.FileUnits(lengths, angles, solidAngles);
    for (int index = 1; index <= lengths.Length(); ++index) {
        auto unit = lengths.Value(index);
        unit.LeftAdjust();
        if (unit.IsEmpty()) {
            throw std::runtime_error("STEP 长度单位缺失，无法可靠还原装配尺寸。");
        }
    }
    if (lengths.IsEmpty()) throw std::runtime_error("STEP 长度单位缺失，无法可靠还原装配尺寸。");
    // OCCT returns geometry in millimeters, regardless of the input units.
    step.SetSystemLengthUnit(1.0);
    STEPConstruct_ExternRefs external(step.WS());
    external.LoadExternRefs();
    if (external.NbExternRefs()) throw std::runtime_error("请使用嵌入全部零件的 STEP 文件。");

    const Handle(TDocStd_Document) document = new TDocStd_Document("BinXCAF");
    if (!reader.Transfer(document)) throw std::runtime_error("STEP 装配转换失败。");
    TDF_LabelSequence roots;
    XCAFDoc_DocumentTool::ShapeTool(document->Main())->GetFreeShapes(roots);
    if (roots.IsEmpty()) throw std::runtime_error("STEP 文件没有装配或零件。");

    Assembly assembly;
    for (int index = 1; index <= roots.Length(); ++index) {
        assembly.visit(roots.Value(index));
    }
    if (assembly.meshes.IsEmpty()) throw std::runtime_error("STEP 文件没有可显示的几何。");
    writeAssembly(assembly, destination);
}

} // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
#else
int main(int argc, char** argv) {
#endif
    const bool gbk = argc == 4 && fs::path(argv[3]) == "--gbk";
    if (argc != 3 && !gbk) {
        std::cerr << "Usage: cad-import <source.step> <output-directory> [--gbk]\n";
        return 1;
    }
    try {
        importStep(argv[1], argv[2], gbk);
        return 0;
    } catch (const Standard_Failure&) {
        std::cerr << "CAD_IMPORT_ERROR:STEP 几何处理失败，请检查文件内容。\n";
    } catch (const fs::filesystem_error&) {
        std::cerr << "CAD_IMPORT_ERROR:无法读取 STEP 文件或写入网格。\n";
    } catch (const std::ios_base::failure&) {
        std::cerr << "CAD_IMPORT_ERROR:无法写入 STEP 解析结果。\n";
    } catch (const std::exception& error) {
        std::cerr << "CAD_IMPORT_ERROR:" << error.what() << '\n';
    }
    return 1;
}
