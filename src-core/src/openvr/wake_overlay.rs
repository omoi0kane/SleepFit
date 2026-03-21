use super::OVR_CONTEXT;
use log::error;
use ovr_overlay as ovr;
use std::sync::LazyLock;
use tokio::sync::Mutex;

const WAKE_OVERLAY_WIDTH_METERS: f32 = 1.0;
const WAKE_OVERLAY_SORT_ORDER: u32 = 210;
const WAKE_OVERLAY_TEXTURE_SIZE: u32 = 256;
const WAKE_OVERLAY_INNER_RADIUS: f64 = 0.25;
const WAKE_OVERLAY_OUTER_RADIUS: f64 = 0.95;

static OVERLAY_HANDLE: LazyLock<Mutex<Option<ovr_overlay::overlay::OverlayHandle>>> =
    LazyLock::new(Default::default);
static OPACITY: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));

pub async fn on_ovr_init(context: &ovr::Context) -> Result<(), String> {
    *OVERLAY_HANDLE.lock().await = None;
    let overlay_handle = match create_overlay(context).await {
        Ok(handle) => handle,
        Err(_) => return Err("Failed to create wake overlay".to_string()),
    };
    *OVERLAY_HANDLE.lock().await = Some(overlay_handle);
    Ok(())
}

pub async fn on_ovr_quit() {
    *OVERLAY_HANDLE.lock().await = None;
    *OPACITY.lock().await = 0.0;
}

pub async fn set_opacity(opacity: f64) {
    let opacity = opacity.clamp(0.0, 1.0);
    *OPACITY.lock().await = opacity;
    let mut context_guard = OVR_CONTEXT.lock().await;
    let context = match context_guard.as_mut() {
        Some(manager) => manager,
        None => return,
    };
    let mut manager = context.overlay_mngr();
    let overlay_handle_guard = OVERLAY_HANDLE.lock().await;
    let overlay_handle = match overlay_handle_guard.as_ref() {
        Some(handle) => handle,
        None => return,
    };
    if let Err(e) = manager.set_opacity(*overlay_handle, opacity as f32) {
        error!("[Core] Failed to set wake overlay opacity: {e}");
    };
}

async fn create_overlay(
    context: &ovr_overlay::Context,
) -> Result<ovr_overlay::overlay::OverlayHandle, ()> {
    let mut manager = context.overlay_mngr();
    let overlay = match manager.create_overlay(
        "com.fleabane.sleepfit:WakeOverlay",
        "SleepFit Wake Overlay",
    ) {
        Ok(handle) => handle,
        Err(_) => return Err(()),
    };
    let image = generate_overlay_texture();
    if let Err(e) = manager.set_raw_data(
        overlay,
        image.as_slice(),
        WAKE_OVERLAY_TEXTURE_SIZE as usize,
        WAKE_OVERLAY_TEXTURE_SIZE as usize,
        4,
    ) {
        error!("[Core] Failed to set wake overlay image data: {e}");
        return Err(());
    }
    let transformation_matrix =
        ovr_overlay::pose::Matrix3x4([[1., 0., 0., 0.], [0., 1., 0., 0.], [0., 0., 1., -0.15]]);
    if let Err(e) = manager.set_transform_tracked_device_relative(
        overlay,
        ovr_overlay::TrackedDeviceIndex::new(0).unwrap(),
        &transformation_matrix,
    ) {
        error!("[Core] Failed to set wake overlay transform: {e}");
        return Err(());
    }
    if let Err(e) = manager.set_sort_order(overlay, WAKE_OVERLAY_SORT_ORDER) {
        error!("[Core] Failed to set wake overlay sort order: {e}");
        return Err(());
    }
    if let Err(e) = manager.set_width(overlay, WAKE_OVERLAY_WIDTH_METERS) {
        error!("[Core] Failed to set wake overlay width: {e}");
        return Err(());
    }
    let opacity = *OPACITY.lock().await;
    if let Err(e) = manager.set_opacity(overlay, opacity as f32) {
        error!("[Core] Failed to set wake overlay opacity: {e}");
        return Err(());
    }
    if let Err(e) = manager.set_visibility(overlay, true) {
        error!("[Core] Failed to set wake overlay visibility: {e}");
        return Err(());
    }
    Ok(overlay)
}

fn generate_overlay_texture() -> Vec<u8> {
    let mut texture =
        Vec::with_capacity((WAKE_OVERLAY_TEXTURE_SIZE * WAKE_OVERLAY_TEXTURE_SIZE * 4) as usize);
    let half_size = (WAKE_OVERLAY_TEXTURE_SIZE - 1) as f64 / 2.0;
    let max_radius = (2.0_f64).sqrt() * half_size;
    for y in 0..WAKE_OVERLAY_TEXTURE_SIZE {
        for x in 0..WAKE_OVERLAY_TEXTURE_SIZE {
            let dx = x as f64 - half_size;
            let dy = y as f64 - half_size;
            let normalized_radius = ((dx * dx + dy * dy).sqrt() / max_radius).clamp(0.0, 1.0);
            let falloff = linear_falloff(
                WAKE_OVERLAY_INNER_RADIUS,
                WAKE_OVERLAY_OUTER_RADIUS,
                normalized_radius,
            );
            let alpha = (falloff * 255.0).round().clamp(0.0, 255.0) as u8;
            texture.extend_from_slice(&[255, 255, 255, alpha]);
        }
    }
    texture
}

fn linear_falloff(edge0: f64, edge1: f64, x: f64) -> f64 {
    ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0)
}
