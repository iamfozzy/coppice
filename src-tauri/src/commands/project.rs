use tauri::State;
use crate::db::Database;
use crate::models::{Project, ProjectFormData};

#[tauri::command]
pub fn list_projects(db: State<'_, Database>) -> Result<Vec<Project>, String> {
    db.list_projects().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_project(db: State<'_, Database>, data: ProjectFormData) -> Result<Project, String> {
    db.create_project(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_project(
    db: State<'_, Database>,
    id: String,
    data: ProjectFormData,
) -> Result<Project, String> {
    db.update_project(&id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_project(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_project(&id).map_err(|e| e.to_string())
}
