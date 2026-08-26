use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClickRequest {
    pub revision: u64,
    pub page: usize,
    pub x_pt: f64,
    pub y_pt: f64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRequest {
    pub revision: u64,
    pub source: String,
    pub byte_offset: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenderedPosition {
    pub page: usize,
    pub x_pt: f64,
    pub y_pt: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub file: Option<String>,
    pub line: Option<usize>,
    pub column: Option<usize>,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageDimensions {
    pub width_pt: f64,
    pub height_pt: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum ClickResponse {
    Source {
        revision: u64,
        path: String,
        #[serde(rename = "byteOffset")]
        byte_offset: usize,
    },
    NoSource {
        revision: u64,
    },
    InvalidRequest {
        revision: u64,
    },
    StaleRevision {
        expected: u64,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum ForwardResponse {
    Positions {
        revision: u64,
        positions: Vec<RenderedPosition>,
    },
    NoPosition {
        revision: u64,
    },
    InvalidRequest {
        revision: u64,
    },
    StaleRevision {
        expected: u64,
    },
}
