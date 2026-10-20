//! Tauri command adapters grouped by capability. Shared filesystem operations live in file_io.

pub mod ai_usage;
mod ai_usage_tokens;
pub mod application;
pub mod controls;
pub mod fonts;
mod http;
pub mod layouts;
pub mod logging;
pub mod packages;
mod public_addr;
pub mod sacks;
pub mod sessions;
pub mod themes;
pub mod wallpapers;
mod watch;
pub mod windows;

pub mod runner;
