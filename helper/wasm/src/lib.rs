use std::collections::{HashMap, HashSet};
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use base64::Engine;
use serde::{Deserialize, Serialize};
use typst::Library;
use typst::diag::{FileError, FileResult, Severity, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::introspection::PagedPosition;
use typst::layout::{Abs, Point};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook, FontInfo};
use typst::utils::LazyHash;
use typst::{LibraryExt, World, WorldExt};
use typst_ide::{IdeWorld, Jump, jump_from_click, jump_from_cursor};
use typst_kit::fonts::{self, FontSource, FontStore};
use typst_layout::PagedDocument;
use typst_pdf::PdfOptions;
use typstian_core::{
    ClickRequest, ClickResponse, Diagnostic, ForwardRequest, ForwardResponse, PageDimensions,
    RenderedPosition,
};
use wasm_bindgen::prelude::*;

const PROTOCOL_VERSION: u32 = 1;
const TYPST_VERSION: &str = "0.15.1";
const MAX_VAULT_FILE_BYTES: usize = 50 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES: usize = 70 * 1024 * 1024;
const MAX_PDF_BYTES: usize = 50 * 1024 * 1024;
const MAX_DEPENDENCIES: usize = 10_000;
const MAX_FONT_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_FONT_FACES: usize = 20_000;
const MAX_FONT_PATH_BYTES: usize = 4_096;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInput {
    pub path: String,
    pub contents_base64: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileRequest {
    pub entry: String,
    pub revision: u64,
    pub files: Vec<FileInput>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub revision: u64,
    pub pdf_base64: String,
    #[serde(skip)]
    pdf: Vec<u8>,
    pub pdf_bytes: usize,
    pub dependencies: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub pages: Vec<PageDimensions>,
}

type Loader = Box<dyn Fn(&str) -> FileResult<Bytes> + Send + Sync>;
type FontLoader = Arc<dyn Fn(&str) -> Option<Bytes> + Send + Sync>;

#[derive(Clone)]
struct RegisteredFont {
    path: String,
    index: u32,
    info: FontInfo,
}

#[derive(Default)]
struct FontCatalog {
    fonts: Vec<RegisteredFont>,
    paths: HashSet<String>,
}

fn shared_font_catalog() -> Arc<RwLock<FontCatalog>> {
    static CATALOG: OnceLock<Arc<RwLock<FontCatalog>>> = OnceLock::new();
    Arc::clone(CATALOG.get_or_init(Default::default))
}

struct HostFontSource {
    path: String,
    index: u32,
    loader: FontLoader,
}

impl FontSource for HostFontSource {
    fn load(&self) -> Option<Font> {
        (self.loader)(&self.path).and_then(|bytes| Font::new(bytes, self.index))
    }
}

struct InMemoryWorld {
    main: FileId,
    library: LazyHash<Library>,
    fonts: FontStore,
    loader: Loader,
    sources: RwLock<HashMap<FileId, Source>>,
    inputs: Mutex<InputCache>,
}

#[derive(Default)]
struct InputCache {
    files: HashMap<FileId, Bytes>,
    bytes: usize,
}

impl InMemoryWorld {
    fn new(
        entry: &str,
        loader: Loader,
        registered_fonts: &[RegisteredFont],
        font_loader: FontLoader,
    ) -> Result<Self, String> {
        let entry = normalize_path(entry)?;
        let vpath = VirtualPath::new(entry).map_err(|error| error.to_string())?;
        let main = FileId::new(RootedPath::new(VirtualRoot::Project, vpath));
        let mut fonts = FontStore::new();
        fonts.extend(fonts::embedded());
        for font in registered_fonts {
            fonts.push((
                HostFontSource {
                    path: font.path.clone(),
                    index: font.index,
                    loader: Arc::clone(&font_loader),
                },
                font.info.clone(),
            ));
        }
        Ok(Self {
            main,
            library: LazyHash::new(Library::builder().build()),
            fonts,
            loader,
            sources: RwLock::new(HashMap::new()),
            inputs: Mutex::new(InputCache::default()),
        })
    }

    fn path(id: FileId) -> FileResult<String> {
        if !matches!(id.root(), VirtualRoot::Project) {
            return Err(FileError::AccessDenied);
        }
        normalize_path(id.vpath().get_without_slash())
            .map_err(|message| FileError::Other(Some(message.into())))
    }

    fn relative_source_path(&self, id: FileId) -> Option<String> {
        (id.vpath().extension() == Some("typ"))
            .then(|| Self::path(id).ok())
            .flatten()
    }

    fn dependencies(&self) -> Vec<String> {
        let mut paths = self
            .inputs
            .lock()
            .unwrap()
            .files
            .keys()
            .filter_map(|id| Self::path(*id).ok())
            .collect::<Vec<_>>();
        paths.sort();
        paths
    }

    fn load(&self, id: FileId, path: &str) -> FileResult<Bytes> {
        let mut cache = self.inputs.lock().unwrap();
        if let Some(bytes) = cache.files.get(&id) {
            return Ok(bytes.clone());
        }
        let bytes = (self.loader)(path)?;
        let (total, _) = validate_input_bounds(bytes.len(), cache.bytes, cache.files.len())
            .map_err(|message| FileError::Other(Some(message.into())))?;
        cache.bytes = total;
        cache.files.insert(id, bytes.clone());
        Ok(bytes)
    }
}

fn validate_input_bounds(
    file_bytes: usize,
    cached_bytes: usize,
    dependencies: usize,
) -> Result<(usize, usize), String> {
    if file_bytes > MAX_VAULT_FILE_BYTES {
        return Err(format!(
            "vault file exceeds {MAX_VAULT_FILE_BYTES} byte limit"
        ));
    }
    if dependencies >= MAX_DEPENDENCIES {
        return Err(format!(
            "compile exceeds {MAX_DEPENDENCIES} dependency limit"
        ));
    }
    let total = cached_bytes
        .checked_add(file_bytes)
        .filter(|total| *total <= MAX_TOTAL_INPUT_BYTES)
        .ok_or_else(|| format!("compile inputs exceed {MAX_TOTAL_INPUT_BYTES} byte limit"))?;
    Ok((total, dependencies + 1))
}

fn ensure_pdf_size(pdf_bytes: usize) -> Result<(), String> {
    (pdf_bytes <= MAX_PDF_BYTES)
        .then_some(())
        .ok_or_else(|| format!("generated PDF exceeds {MAX_PDF_BYTES} byte limit"))
}

impl World for InMemoryWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts.book()
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if let Some(source) = self.sources.read().unwrap().get(&id) {
            return Ok(source.clone());
        }
        let path = Self::path(id)?;
        if !path.ends_with(".typ") {
            return Err(FileError::NotFound(path.into()));
        }
        let bytes = self.load(id, &path)?;
        let text = std::str::from_utf8(&bytes)
            .map_err(|error| FileError::Other(Some(error.to_string().into())))?;
        let source = Source::new(id, text.into());
        self.sources.write().unwrap().insert(id, source.clone());
        Ok(source)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        let path = Self::path(id)?;
        self.load(id, &path)
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.font(index)
    }

    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        None
    }
}

impl IdeWorld for InMemoryWorld {
    fn upcast(&self) -> &dyn World {
        self
    }
}

fn normalize_path(path: &str) -> Result<String, String> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') {
        return Err(format!("invalid vault-relative path: {path}"));
    }
    let mut normalized = Vec::new();
    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => return Err(format!("path escapes vault root: {path}")),
            value => normalized.push(value),
        }
    }
    if normalized.is_empty() {
        return Err(format!("invalid vault-relative path: {path}"));
    }
    Ok(normalized.join("/"))
}

fn map_diagnostic(world: &InMemoryWorld, diagnostic: SourceDiagnostic) -> Diagnostic {
    let location = diagnostic.span.id().and_then(|id| {
        let file = world.relative_source_path(id)?;
        let source = world.source(id).ok()?;
        let range = world.range(diagnostic.span)?;
        let lines = source.lines();
        let line = lines.byte_to_line(range.start)?;
        let line_start = lines.line_to_byte(line)?;
        let column = source.text()[line_start..range.start]
            .encode_utf16()
            .count();
        Some((file, line + 1, column + 1))
    });
    Diagnostic {
        file: location.as_ref().map(|value| value.0.clone()),
        line: location.as_ref().map(|value| value.1),
        column: location.map(|value| value.2),
        severity: match diagnostic.severity {
            Severity::Error => "error".into(),
            Severity::Warning => "warning".into(),
        },
        message: diagnostic.message.to_string(),
    }
}

fn protocol_json(value: impl Serialize, request_type: &str) -> Result<String, JsValue> {
    let mut value =
        serde_json::to_value(value).map_err(|error| JsValue::from_str(&error.to_string()))?;
    if let Some(object) = value.as_object_mut() {
        if let Some(status) = object.remove("status") {
            if status == "invalid-request" {
                object.insert("type".into(), "error".into());
                object.insert("requestType".into(), request_type.into());
                object.insert("code".into(), "invalid-request".into());
                object.insert(
                    "message".into(),
                    format!("Invalid {request_type} request").into(),
                );
            } else {
                object.insert("type".into(), status);
            }
        }
        if let Some(expected) = object.remove("expected") {
            object.insert("expectedRevision".into(), expected);
        }
    }
    serde_json::to_string(&value).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[derive(Default)]
pub struct Session {
    revision: Option<u64>,
    world: Option<InMemoryWorld>,
    document: Option<PagedDocument>,
    catalog: Arc<RwLock<FontCatalog>>,
}

impl Session {
    pub fn new() -> Self {
        Self::default()
    }

    fn with_catalog(catalog: Arc<RwLock<FontCatalog>>) -> Self {
        Self {
            catalog,
            ..Self::default()
        }
    }

    pub fn register_font(&mut self, path: &str, bytes: &[u8]) -> Result<usize, String> {
        if path.is_empty() || path.len() > MAX_FONT_PATH_BYTES {
            return Err(format!(
                "font path must contain 1..={MAX_FONT_PATH_BYTES} bytes"
            ));
        }
        let mut catalog = self
            .catalog
            .write()
            .map_err(|_| "system font catalog lock poisoned".to_string())?;
        if catalog.paths.contains(path) {
            return Ok(0);
        }
        if bytes.is_empty() || bytes.len() > MAX_FONT_FILE_BYTES {
            return Err(format!(
                "font file must contain 1..={MAX_FONT_FILE_BYTES} bytes"
            ));
        }
        let fonts = Font::iter(Bytes::new(bytes.to_vec())).collect::<Vec<_>>();
        if fonts.is_empty() {
            return Err("invalid or unsupported font file".into());
        }
        if catalog.fonts.len() + fonts.len() > MAX_FONT_FACES {
            return Err(format!(
                "registered fonts exceed {MAX_FONT_FACES} face limit"
            ));
        }
        let count = fonts.len();
        catalog
            .fonts
            .extend(fonts.into_iter().map(|font| RegisteredFont {
                path: path.into(),
                index: font.index(),
                info: font.info().clone(),
            }));
        catalog.paths.insert(path.into());
        Ok(count)
    }

    pub fn compile(&mut self, request: CompileRequest) -> Result<CompileResult, String> {
        let mut files = HashMap::new();
        for file in request.files {
            let path = normalize_path(&file.path)?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(file.contents_base64)
                .map_err(|error| format!("invalid base64 for {path}: {error}"))?;
            if files.insert(path.clone(), Bytes::new(bytes)).is_some() {
                return Err(format!("duplicate file: {path}"));
            }
        }
        let mut result = self.compile_with_loader(
            request.entry,
            request.revision,
            Box::new(move |path| {
                files
                    .get(path)
                    .cloned()
                    .ok_or_else(|| FileError::NotFound(path.into()))
            }),
            Arc::new(|_| None),
        )?;
        if !result.pdf.is_empty() {
            result.pdf_base64 = base64::engine::general_purpose::STANDARD.encode(&result.pdf);
        }
        Ok(result)
    }

    fn compile_with_loader(
        &mut self,
        entry: String,
        revision: u64,
        loader: Loader,
        font_loader: FontLoader,
    ) -> Result<CompileResult, String> {
        let registered_fonts = self
            .catalog
            .read()
            .map_err(|_| "system font catalog lock poisoned".to_string())?
            .fonts
            .clone();
        let world = InMemoryWorld::new(&entry, loader, &registered_fonts, font_loader)?;
        let result = typst::compile::<PagedDocument>(&world);
        let mut diagnostics = result
            .warnings
            .into_iter()
            .map(|warning| {
                let mut mapped = map_diagnostic(&world, warning);
                mapped.severity = "warning".into();
                mapped
            })
            .collect::<Vec<_>>();
        let document = match result.output {
            Ok(document) => document,
            Err(errors) => {
                diagnostics.extend(
                    errors
                        .into_iter()
                        .map(|error| map_diagnostic(&world, error)),
                );
                return Ok(CompileResult {
                    kind: "compiled",
                    revision,
                    pdf_base64: String::new(),
                    pdf: Vec::new(),
                    pdf_bytes: 0,
                    dependencies: world.dependencies(),
                    diagnostics,
                    pages: Vec::new(),
                });
            }
        };
        let pdf = typst_pdf::pdf(&document, &PdfOptions::default())
            .map_err(|errors| format!("PDF export failed: {errors:?}"))?;
        ensure_pdf_size(pdf.len())?;
        let pages = document
            .pages()
            .iter()
            .map(|page| PageDimensions {
                width_pt: page.frame.width().to_pt(),
                height_pt: page.frame.height().to_pt(),
            })
            .collect();
        let pdf_bytes = pdf.len();
        let compiled = CompileResult {
            kind: "compiled",
            revision,
            pdf_base64: String::new(),
            pdf,
            pdf_bytes,
            dependencies: world.dependencies(),
            diagnostics,
            pages,
        };
        self.revision = Some(revision);
        self.world = Some(world);
        self.document = Some(document);
        Ok(compiled)
    }

    pub fn click(&self, request: ClickRequest) -> ClickResponse {
        let Some(revision) = self.revision else {
            return ClickResponse::InvalidRequest {
                revision: request.revision,
            };
        };
        if request.revision != revision {
            return ClickResponse::StaleRevision { expected: revision };
        }
        let (Some(world), Some(document), Some(page)) = (
            self.world.as_ref(),
            self.document.as_ref(),
            NonZeroUsize::new(request.page),
        ) else {
            return ClickResponse::InvalidRequest { revision };
        };
        if request.page > document.pages().len()
            || !request.x_pt.is_finite()
            || !request.y_pt.is_finite()
            || request.x_pt < 0.0
            || request.y_pt < 0.0
        {
            return ClickResponse::InvalidRequest { revision };
        }
        let position = PagedPosition {
            page,
            point: Point::new(Abs::pt(request.x_pt), Abs::pt(request.y_pt)),
        };
        match jump_from_click(world, document, &position) {
            Some(Jump::File(id, byte_offset)) => match world.relative_source_path(id) {
                Some(path) => ClickResponse::Source {
                    revision,
                    path,
                    byte_offset,
                },
                None => ClickResponse::NoSource { revision },
            },
            _ => ClickResponse::NoSource { revision },
        }
    }

    pub fn forward(&self, request: ForwardRequest) -> ForwardResponse {
        let Some(revision) = self.revision else {
            return ForwardResponse::InvalidRequest {
                revision: request.revision,
            };
        };
        if request.revision != revision {
            return ForwardResponse::StaleRevision { expected: revision };
        }
        let (Some(world), Some(document)) = (self.world.as_ref(), self.document.as_ref()) else {
            return ForwardResponse::InvalidRequest { revision };
        };
        let Ok(path) = normalize_path(&request.source) else {
            return ForwardResponse::InvalidRequest { revision };
        };
        let Ok(vpath) = VirtualPath::new(path) else {
            return ForwardResponse::InvalidRequest { revision };
        };
        let id = FileId::new(RootedPath::new(VirtualRoot::Project, vpath));
        let Ok(source) = world.source(id) else {
            return ForwardResponse::InvalidRequest { revision };
        };
        if request.byte_offset > source.text().len()
            || !source.text().is_char_boundary(request.byte_offset)
        {
            return ForwardResponse::InvalidRequest { revision };
        }
        let positions = jump_from_cursor(document, &source, request.byte_offset)
            .into_iter()
            .filter_map(|position| {
                let rendered = RenderedPosition {
                    page: position.page.get(),
                    x_pt: position.point.x.to_pt(),
                    y_pt: position.point.y.to_pt(),
                };
                (rendered.page <= 1000
                    && rendered.x_pt.is_finite()
                    && rendered.y_pt.is_finite()
                    && rendered.x_pt >= 0.0
                    && rendered.y_pt >= 0.0)
                    .then_some(rendered)
            })
            .take(1000)
            .collect::<Vec<_>>();
        if positions.is_empty() {
            ForwardResponse::NoPosition { revision }
        } else {
            ForwardResponse::Positions {
                revision,
                positions,
            }
        }
    }
}

#[cfg(target_arch = "wasm32")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmCompileRequest {
    entry: String,
    revision: u64,
}

#[wasm_bindgen]
pub struct TypstianWasmSession {
    inner: Session,
}

#[wasm_bindgen]
impl TypstianWasmSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Session::with_catalog(shared_font_catalog()),
        }
    }

    pub fn register_font(&mut self, path: &str, bytes: &[u8]) -> Result<usize, JsValue> {
        self.inner
            .register_font(path, bytes)
            .map_err(|error| JsValue::from_str(&error))
    }

    pub fn environment(&self) -> String {
        serde_json::json!({
            "type": "environment",
            "protocolVersion": PROTOCOL_VERSION,
            "typstVersion": TYPST_VERSION,
        })
        .to_string()
    }

    #[cfg(target_arch = "wasm32")]
    pub fn compile(
        &mut self,
        request_json: &str,
        read_file: &js_sys::Function,
        read_font: &js_sys::Function,
    ) -> Result<JsValue, JsValue> {
        let request: WasmCompileRequest = serde_json::from_str(request_json)
            .map_err(|error| JsValue::from_str(&format!("invalid compile request: {error}")))?;
        let read_file = read_file.clone();
        let read_font = read_font.clone();
        let result = self
            .inner
            .compile_with_loader(
                request.entry,
                request.revision,
                Box::new(move |path| {
                    let value = read_file
                        .call1(&JsValue::NULL, &JsValue::from_str(path))
                        .map_err(|_| {
                            FileError::Other(Some(format!("readFile failed for {path}").into()))
                        })?;
                    if value.is_null() || value.is_undefined() {
                        return Err(FileError::NotFound(path.into()));
                    }
                    let array = js_sys::Uint8Array::new(&value);
                    if array.length() as usize > MAX_VAULT_FILE_BYTES {
                        return Err(FileError::Other(Some(
                            format!("vault file exceeds {MAX_VAULT_FILE_BYTES} byte limit").into(),
                        )));
                    }
                    Ok(Bytes::new(array.to_vec()))
                }),
                Arc::new(move |path| {
                    let value = read_font
                        .call1(&JsValue::NULL, &JsValue::from_str(path))
                        .ok()?;
                    if value.is_null() || value.is_undefined() {
                        return None;
                    }
                    let array = js_sys::Uint8Array::new(&value);
                    if array.length() as usize > MAX_FONT_FILE_BYTES {
                        return None;
                    }
                    Some(Bytes::new(array.to_vec()))
                }),
            )
            .map_err(|error| JsValue::from_str(&error))?;
        if result.pdf.is_empty() {
            let message = result
                .diagnostics
                .iter()
                .find(|diagnostic| diagnostic.severity == "error")
                .map(|diagnostic| diagnostic.message.as_str())
                .unwrap_or("Typst compilation failed");
            return Ok(JsValue::from_str(
                &serde_json::json!({
                    "type": "error",
                    "requestType": "compile",
                    "revision": result.revision,
                    "code": "compile",
                    "message": message,
                    "dependencies": result.dependencies,
                    "diagnostics": result.diagnostics,
                })
                .to_string(),
            ));
        }

        let response_json = serde_json::json!({
            "type": result.kind,
            "revision": result.revision,
            "pdfBytes": result.pdf_bytes,
            "dependencies": result.dependencies,
            "diagnostics": result.diagnostics,
            "pages": result.pages,
        })
        .to_string();
        let response = js_sys::JSON::parse(&response_json)
            .map_err(|_| JsValue::from_str("failed to encode compile response"))?;
        let pdf = js_sys::Uint8Array::from(result.pdf.as_slice());
        js_sys::Reflect::set(&response, &JsValue::from_str("pdfBuffer"), &pdf.buffer())?;
        Ok(response)
    }

    pub fn jump(&self, request_json: &str) -> Result<String, JsValue> {
        let request = serde_json::from_str(request_json)
            .map_err(|error| JsValue::from_str(&format!("invalid jump request: {error}")))?;
        protocol_json(self.inner.click(request), "jump")
    }

    pub fn forward(&self, request_json: &str) -> Result<String, JsValue> {
        let request = serde_json::from_str(request_json)
            .map_err(|error| JsValue::from_str(&format!("invalid forward request: {error}")))?;
        protocol_json(self.inner.forward(request), "forward")
    }
}

#[cfg(test)]
mod font_tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn jump_protocol_serializes_byte_offset_as_camel_case() {
        let response = protocol_json(
            ClickResponse::Source {
                revision: 1,
                path: "main.typ".into(),
                byte_offset: 7,
            },
            "jump",
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&response).unwrap();

        assert_eq!(value["byteOffset"], 7);
        assert!(value.get("byte_offset").is_none());
    }

    #[test]
    fn registered_system_font_is_loaded_only_when_selected() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(include_str!("../../tests/fixtures/fonts/colr_1.ttf.base64").trim())
            .unwrap();
        let font = Font::iter(Bytes::new(bytes.clone()))
            .next()
            .expect("font fixture should be scannable");
        let family = font.info().family.to_string();
        let source = Bytes::from_string(format!("#set text(font: \"{family}\")\nSystem font"));
        let loads = Arc::new(AtomicUsize::new(0));
        let loads_for_loader = Arc::clone(&loads);
        let font_bytes = Bytes::new(bytes.clone());
        let catalog = Arc::new(RwLock::new(FontCatalog::default()));
        let mut registrar = Session::with_catalog(Arc::clone(&catalog));
        let mut session = Session::with_catalog(catalog);

        assert_eq!(registrar.register_font("system.ttf", &bytes).unwrap(), 1);
        drop(registrar);
        assert_eq!(loads.load(Ordering::SeqCst), 0);
        let compiled = session
            .compile_with_loader(
                "main.typ".into(),
                8,
                Box::new(move |path| {
                    (path == "main.typ")
                        .then(|| source.clone())
                        .ok_or_else(|| FileError::NotFound(path.into()))
                }),
                Arc::new(move |path| {
                    (path == "system.ttf").then(|| {
                        loads_for_loader.fetch_add(1, Ordering::SeqCst);
                        font_bytes.clone()
                    })
                }),
            )
            .expect("fixture compiles");

        assert!(!compiled.pdf.is_empty());
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }
}

impl Default for TypstianWasmSession {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod resource_limit_tests {
    use super::*;

    #[test]
    fn rejects_input_before_it_exceeds_any_cache_bound() {
        assert!(validate_input_bounds(MAX_VAULT_FILE_BYTES + 1, 0, 0).is_err());
        assert!(validate_input_bounds(2, MAX_TOTAL_INPUT_BYTES - 1, 0).is_err());
        assert!(validate_input_bounds(1, 0, MAX_DEPENDENCIES).is_err());
        assert_eq!(
            validate_input_bounds(MAX_VAULT_FILE_BYTES, 0, 0).unwrap(),
            (MAX_VAULT_FILE_BYTES, 1)
        );
    }

    #[test]
    fn rejects_pdf_before_base64_expansion() {
        assert!(ensure_pdf_size(MAX_PDF_BYTES + 1).is_err());
        assert!(ensure_pdf_size(MAX_PDF_BYTES).is_ok());
    }
}
