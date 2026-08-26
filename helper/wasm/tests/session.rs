use base64::Engine;
use typstian_core::{
    ClickRequest, ClickResponse, ForwardRequest, ForwardResponse, PageDimensions, RenderedPosition,
};
use typstian_wasm::{CompileRequest, FileInput, Session};

fn fixture(group: &str, path: &str) -> FileInput {
    let bytes = std::fs::read(format!("../tests/fixtures/{group}/{path}")).unwrap();
    file_input(path, &bytes)
}

fn file_input(path: &str, bytes: &[u8]) -> FileInput {
    FileInput {
        path: path.into(),
        contents_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    }
}

fn project_request(revision: u64) -> CompileRequest {
    CompileRequest {
        entry: "main.typ".into(),
        revision,
        files: vec![
            fixture("project", "main.typ"),
            fixture("project", "section.typ"),
            fixture("project", "assets/mark.svg"),
        ],
    }
}

fn first_position(
    session: &Session,
    revision: u64,
    source: &str,
    byte_offset: usize,
) -> Option<typstian_core::RenderedPosition> {
    match session.forward(ForwardRequest {
        revision,
        source: source.into(),
        byte_offset,
    }) {
        ForwardResponse::Positions { positions, .. } => positions.into_iter().next(),
        _ => None,
    }
}

fn click_at(session: &Session, revision: u64, position: RenderedPosition) -> ClickResponse {
    session.click(ClickRequest {
        revision,
        page: position.page,
        x_pt: position.x_pt,
        y_pt: position.y_pt,
    })
}

fn inverse_position(
    session: &Session,
    revision: u64,
    pages: &[PageDimensions],
    expected_path: &str,
    expected_offset: usize,
) -> Option<RenderedPosition> {
    for (page_index, page) in pages.iter().enumerate() {
        for y in 0..page.height_pt.ceil() as usize {
            for x in 0..page.width_pt.ceil() as usize {
                let position = RenderedPosition {
                    page: page_index + 1,
                    x_pt: x as f64 + 0.5,
                    y_pt: y as f64 + 0.5,
                };
                if matches!(
                    click_at(session, revision, position.clone()),
                    ClickResponse::Source {
                        path,
                        byte_offset,
                        ..
                    } if path == expected_path && byte_offset == expected_offset
                ) {
                    return Some(position);
                }
            }
        }
    }
    None
}

#[test]
fn compiles_imports_images_and_both_navigation_directions() {
    let section = std::fs::read("../tests/fixtures/project/section.typ").unwrap();
    let byte_offset = std::str::from_utf8(&section).unwrap().find('한').unwrap();
    let mut session = Session::new();
    let compiled = session
        .compile(project_request(7))
        .expect("fixture compiles");

    assert_eq!(compiled.revision, 7);
    assert!(!compiled.pdf_base64.is_empty());
    assert!(!compiled.pages.is_empty());
    assert!(
        compiled
            .dependencies
            .iter()
            .any(|path| path == "assets/mark.svg"),
        "binary assets are compile dependencies"
    );

    let position = first_position(&session, 7, "section.typ", byte_offset)
        .expect("forward search should find imported Unicode text");
    assert!(matches!(
        click_at(&session, 7, position),
        ClickResponse::Source { path, .. } if path == "section.typ"
    ));
}

#[test]
fn maps_imported_unicode_glyph_to_exact_utf8_byte_offset() {
    let section = std::fs::read("../tests/fixtures/project/section.typ").unwrap();
    let expected = std::str::from_utf8(&section).unwrap().find('한').unwrap();
    let mut session = Session::new();
    let compiled = session
        .compile(project_request(2))
        .expect("fixture compiles");
    let position = inverse_position(&session, 2, &compiled.pages, "section.typ", expected)
        .expect("imported glyph should have an exact inverse-search position");

    assert_eq!(
        click_at(&session, 2, position),
        ClickResponse::Source {
            revision: 2,
            path: "section.typ".into(),
            byte_offset: expected,
        }
    );
}

#[test]
fn rejects_stale_click_revision_without_recompiling() {
    let mut session = Session::new();
    session
        .compile(project_request(10))
        .expect("fixture compiles");

    assert_eq!(
        session.click(ClickRequest {
            revision: 9,
            page: 1,
            x_pt: 10.0,
            y_pt: 10.0,
        }),
        ClickResponse::StaleRevision { expected: 10 }
    );
}

#[test]
fn maps_compile_error_to_exact_source_location() {
    let mut session = Session::new();
    let result = session
        .compile(CompileRequest {
            entry: "invalid.typ".into(),
            revision: 11,
            files: vec![fixture("diagnostics", "invalid.typ")],
        })
        .expect("compile diagnostics are a protocol result");

    assert!(result.pdf_base64.is_empty());
    let diagnostic = result.diagnostics.first().expect("at least one diagnostic");
    assert_eq!(diagnostic.file.as_deref(), Some("invalid.typ"));
    assert_eq!(diagnostic.line, Some(2));
    assert_eq!(diagnostic.column, Some(15));
    assert_eq!(diagnostic.severity, "error");
    assert!(!diagnostic.message.is_empty());
}

#[test]
fn maps_diagnostic_column_as_utf16_for_javascript_clients() {
    let mut session = Session::new();
    let result = session
        .compile(CompileRequest {
            entry: "astral.typ".into(),
            revision: 14,
            files: vec![fixture("diagnostics", "astral.typ")],
        })
        .expect("compile diagnostics are a protocol result");

    let diagnostic = result.diagnostics.first().expect("at least one diagnostic");
    assert_eq!(diagnostic.line, Some(1));
    assert_eq!(diagnostic.column, Some(18));
}

#[test]
fn rejects_image_outside_virtual_root() {
    let mut session = Session::new();
    let result = session
        .compile(CompileRequest {
            entry: "image.typ".into(),
            revision: 4,
            files: vec![fixture("escape/vault", "image.typ")],
        })
        .expect("missing external image is a compile result");

    assert!(result.pdf_base64.is_empty());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == "error")
    );
}

#[test]
fn rejects_package_import_without_network_resolution() {
    let mut session = Session::new();
    let result = session
        .compile(CompileRequest {
            entry: "package.typ".into(),
            revision: 5,
            files: vec![fixture("escape/vault", "package.typ")],
        })
        .expect("missing package is a compile result");

    assert!(result.pdf_base64.is_empty());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == "error")
    );
}

#[test]
fn click_uses_retained_snapshot_after_source_input_changes() {
    let main = fixture("project", "main.typ");
    let asset = fixture("project", "assets/mark.svg");
    let section_bytes = std::fs::read("../tests/fixtures/project/section.typ").unwrap();
    let expected = std::str::from_utf8(&section_bytes)
        .unwrap()
        .find('한')
        .unwrap();
    let mut mutable_input = file_input("section.typ", &section_bytes);
    let mut session = Session::new();
    session
        .compile(CompileRequest {
            entry: "main.typ".into(),
            revision: 17,
            files: vec![main, mutable_input.clone(), asset],
        })
        .expect("fixture compiles");
    let position = first_position(&session, 17, "section.typ", expected)
        .expect("imported glyph should have a rendered position");
    let before = click_at(&session, 17, position.clone());

    mutable_input.contents_base64 = base64::engine::general_purpose::STANDARD.encode("#invalid(");

    assert_eq!(click_at(&session, 17, position), before);
    assert!(matches!(
        before,
        ClickResponse::Source { path, .. } if path == "section.typ"
    ));
}
