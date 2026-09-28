//! Tauri command adapters grouped by capability. Shared filesystem operations live in file_io.

pub mod application;
pub mod controls;
pub mod fonts;
mod http;
pub mod layouts;
pub mod logging;
pub mod packages;
pub mod sacks;
pub mod sessions;
pub mod themes;
pub mod wallpapers;
mod watch;
pub mod windows;
